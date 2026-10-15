import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFHexString, PDFName, PDFString } from '@cantoo/pdf-lib';
import { AUDIT_ATTACHMENT_NAME, HANDOFF_ATTACHMENT_NAME } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import { SignPdfError, readHandoffPdf, resolveRequest, verifySignedPdf } from './index.ts';
import { inflateCapped } from './inflate.ts';
import { MAX_AUDIT_RECORD_BYTES, MAX_HANDOFF_CHARS } from './limits.ts';
import { checkSignaturePng } from './png.ts';
import { finalizeDocument } from './sign.ts';
import { humanInput, makePng, makePngFromRaw, requestFor } from './test-helpers.ts';

/** A PDF with one embedded file whose stream is given as is: compressed bytes and its dictionary entries. */
async function pdfWithRawAttachment(name: string, contents: Uint8Array, entries: Record<string, unknown> = {}) {
  const doc = await PDFDocument.create();
  doc.addPage();
  const context = doc.context;
  const stream = context.register(
    context.stream(contents, { Type: 'EmbeddedFile', Filter: 'FlateDecode', ...entries } as never),
  );
  const spec = context.register(
    context.obj({ Type: 'Filespec', F: PDFString.of(name), UF: PDFHexString.fromText(name), EF: { F: stream } }),
  );
  doc.catalog.set(
    PDFName.of('Names'),
    context.obj({ EmbeddedFiles: { Names: [PDFHexString.fromText(name), spec] } }),
  );
  return doc.save({ useObjectStreams: false });
}

describe('inflateCapped', () => {
  it('inflates up to the cap and stops past it', () => {
    const data = deflateSync(new Uint8Array(100_000));
    expect(inflateCapped(data, 100_000)?.length).toBe(100_000);
    expect(inflateCapped(data, 99_999)).toBeUndefined();
    expect(() => inflateCapped(new Uint8Array([1, 2, 3, 4, 5, 6]), 10)).toThrow();
  });
});

describe('attachment decompression bombs', () => {
  it('stops inflating hand-off data at its cap', async () => {
    const bomb = deflateSync(new Uint8Array(MAX_HANDOFF_CHARS + 1024));
    // The compressed data is small: the PDF is far under the size limit.
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const pdf = await pdfWithRawAttachment(HANDOFF_ATTACHMENT_NAME, bomb);
    const error = await readHandoffPdf(pdf).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignPdfError);
    expect(error).toMatchObject({ code: 'invalid-handoff', message: 'The hand-off data is too large.' });
  }, 30_000);

  it('rejects a declared size over the cap before inflating', async () => {
    const pdf = await pdfWithRawAttachment(HANDOFF_ATTACHMENT_NAME, deflateSync(new Uint8Array(10)), {
      Params: { Size: MAX_HANDOFF_CHARS + 1 },
    });
    await expect(readHandoffPdf(pdf)).rejects.toMatchObject({ code: 'invalid-handoff', message: 'The hand-off data is too large.' });
  });

  it('rejects an encoding other than FlateDecode', async () => {
    const pdf = await pdfWithRawAttachment(HANDOFF_ATTACHMENT_NAME, new Uint8Array(10), { Filter: 'LZWDecode' });
    await expect(readHandoffPdf(pdf)).rejects.toMatchObject({ code: 'invalid-handoff', message: expect.stringContaining('not supported') });
  });

  it('stops inflating an audit record at its cap, and does not read other attachments', async () => {
    const bomb = deflateSync(new Uint8Array(MAX_AUDIT_RECORD_BYTES * 4));
    const result = await verifySignedPdf(await pdfWithRawAttachment(AUDIT_ATTACHMENT_NAME, bomb));
    expect(result.hasAuditRecord).toBe(false);
    expect(result.problems).toEqual(['The audit record is too large.']);

    // An attachment with another name is never inflated, however large.
    const other = await verifySignedPdf(await pdfWithRawAttachment('other.bin', bomb));
    expect(other.problems).toEqual([`No ${AUDIT_ATTACHMENT_NAME} attachment: the PDF was not signed with sign-pdf.`]);
  });
});

describe('PNG decompression bombs', () => {
  // One row of 10 RGBA pixels is a filter byte plus 40 bytes.
  const rows = (count: number) => new Uint8Array(count * 41).fill(0);

  it('accepts image data of the size the header implies', () => {
    expect(checkSignaturePng(makePng(10, 10))).toBeUndefined();
  });

  it('refuses image data larger than the header implies, before decoding', () => {
    const bomb = makePngFromRaw(10, 10, new Uint8Array(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(256 * 1024);
    expect(checkSignaturePng(bomb)).toMatchObject({ problem: 'not-png', message: expect.stringContaining('more data than its size allows') });
    expect(checkSignaturePng(makePngFromRaw(10, 10, rows(11)))?.problem).toBe('not-png');
  });

  it('refuses chunks the decoder would inflate', () => {
    const zText = new Uint8Array([...new TextEncoder().encode('Comment'), 0, 0, ...deflateSync(new Uint8Array(1024))]);
    const png = makePngFromRaw(10, 10, rows(10), [['zTXt', zText]]);
    expect(checkSignaturePng(png)).toMatchObject({ problem: 'not-png', message: expect.stringContaining('"zTXt"') });
  });

  it('makes finalize reject a bomb signature', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const pdf = await doc.save();
    const request = await requestFor(pdf, [
      { id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'rect', page: 1, x: 72, y: 600, width: 200, height: 50 } },
    ]);
    const resolved = await resolveRequest(pdf, request);
    const png = makePngFromRaw(10, 10, new Uint8Array(16 * 1024 * 1024));
    await expect(
      finalizeDocument(pdf, resolved, humanInput({ signatures: { sig: { png, method: 'drawn' } } })),
    ).rejects.toMatchObject({ code: 'invalid-request', message: expect.stringContaining('more data than its size allows') });
  });
});
