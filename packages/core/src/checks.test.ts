import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { AUDIT_ATTACHMENT_NAME, type FieldInput, type Rect, type ResolvedRequest } from '@sign-pdf/spec';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from './index.ts';
import {
  MAX_PACKET_CHARS,
  MAX_PDF_BYTES,
  MAX_SIGNATURE_IMAGE_SIDE,
  SignPdfError,
  checkFieldValue,
  configurePdfjs,
  createPacket,
  decodePacket,
  inspectPdf,
  resolveRequest,
  verifySignedPdf,
  type PdfjsLike,
  type TextItem,
} from './index.ts';
import * as sign from './sign.ts';
import { finalizeDocument, type HumanInput } from './sign.ts';
import { humanInput, makePng, makePngHeaderOnly, readPageMarks, requestFor } from './test-helpers.ts';

const rect = (page: number, x: number, y: number, width: number, height: number) =>
  ({ kind: 'rect', page, x, y, width, height }) as const;

async function blankPdf(size: [number, number] = [612, 792]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage(size);
  return doc.save();
}

async function failure(promise: Promise<unknown>): Promise<SignPdfError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SignPdfError);
  return error as SignPdfError;
}

function expectInside(item: TextItem | undefined, box: Rect): asserts item is TextItem {
  expect(item, 'text run not found').toBeDefined();
  if (!item) return;
  expect(item.page).toBe(box.page);
  expect(item.x).toBeGreaterThanOrEqual(box.x - 0.01);
  expect(item.y).toBeGreaterThanOrEqual(box.y - 0.01);
  expect(item.x + item.width).toBeLessThanOrEqual(box.x + box.width + 0.01);
  expect(item.y + item.height).toBeLessThanOrEqual(box.y + box.height + 0.01);
}

const textField = (id: string, assignee: 'agent' | 'human', extra: Record<string, unknown> = {}): FieldInput =>
  ({ id, type: 'text', assignee, placement: rect(1, 72, 300, 200, 20), ...extra }) as FieldInput;

/** A second font, read from the pdf.js package, with glyphs the bundled font lacks (arrows) and the reverse. */
function otherFont(): Uint8Array {
  const require = createRequire(import.meta.url);
  return new Uint8Array(readFileSync(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')));
}

afterEach(() => configurePdfjs(undefined));

describe('public surface', () => {
  it('the index entry exports nothing that signs', () => {
    expect(Object.keys(core).sort()).toEqual([
      'DEFAULT_PREVIEW_SCALE',
      'FIELD_COLORS',
      'MAX_PACKET_CHARS',
      'MAX_PDF_BYTES',
      'MAX_PLACEMENT_CANDIDATES',
      'MAX_PREVIEW_SCALE',
      'MAX_SIGNATURE_IMAGE_SIDE',
      'MIN_PREVIEW_SCALE',
      'PLACEMENT_CANDIDATE_COLOR',
      'RULER_LEFT',
      'RULER_TOP',
      'SignPdfError',
      'anchorCandidatesOf',
      'buildDraftRequest',
      'checkFieldValue',
      'checkPasses',
      'checkPreviewOptions',
      'configurePdfjs',
      'createPacket',
      'decodeHandoff',
      'decodePacket',
      'encodePacket',
      'findCandidatesInPdf',
      'findPlacementCandidates',
      'inspectPdf',
      'nearestTextMatches',
      'readHandoffPdf',
      'renderPreview',
      'requestSha256',
      'resolveRequest',
      'resolveRequestCollect',
      'sha256Hex',
      'validateRequestAgainstPdf',
      'verifySignedPdf',
    ]);
    expect(core).not.toHaveProperty('finalizeDocument');
  });

  it('the sign entry exports only finalizeDocument, buildHandoffPdf and the marker', () => {
    expect(Object.keys(sign).sort()).toEqual(['SIGNING_CODE_MARKER', 'buildHandoffPdf', 'finalizeDocument']);
  });
});

describe('text that does not fit', () => {
  const long = 'An agreement clause that goes on and on. '.repeat(9).trim(); // 368 characters
  const thirtyLines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join('\n');

  it('is rejected by resolveRequest for values written into the request', async () => {
    const pdf = await blankPdf();
    const single = await failure(resolveRequest(pdf, await requestFor(pdf, [textField('clause', 'agent', { value: long })])));
    expect(single.code).toBe('value-does-not-fit');
    expect(single.fieldId).toBe('clause');

    const block = await failure(
      resolveRequest(
        pdf,
        await requestFor(pdf, [
          textField('lines', 'agent', { value: thirtyLines, multiline: true, placement: rect(1, 72, 300, 120, 30) }),
        ]),
      ),
    );
    expect(block.code).toBe('value-does-not-fit');
    expect(block.fieldId).toBe('lines');
  });

  it('is rejected by finalizeDocument for values the human supplies', async () => {
    const pdf = await blankPdf();
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [
        textField('clause', 'human'),
        textField('lines', 'human', { multiline: true, required: false, placement: rect(1, 72, 400, 120, 30) }),
      ]),
    );
    const single = await failure(finalizeDocument(pdf, resolved, humanInput({ values: { clause: long } })));
    expect(single.code).toBe('value-does-not-fit');
    expect(single.fieldId).toBe('clause');
    const block = await failure(
      finalizeDocument(pdf, resolved, humanInput({ values: { clause: 'Short', lines: thirtyLines } })),
    );
    expect(block.code).toBe('value-does-not-fit');
    expect(block.fieldId).toBe('lines');
  });

  it('is rejected when the human shrinks a field below what its value needs', async () => {
    const pdf = await blankPdf();
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [textField('name', 'agent', { value: 'Ada Example of Example Co' })]),
    );
    const error = await failure(
      finalizeDocument(pdf, resolved, humanInput({ rects: { name: { page: 1, x: 72, y: 300, width: 30, height: 20 } } })),
    );
    expect(error.code).toBe('value-does-not-fit');
    expect(error.fieldId).toBe('name');
  });

  it('keeps everything that is drawn inside the rectangle, at any length that fits', async () => {
    const pdf = await blankPdf();
    const single = { page: 1, x: 72, y: 300, width: 200, height: 20 };
    const block = { page: 1, x: 72, y: 400, width: 120, height: 60 };
    const word = 'word ';
    for (const count of [1, 8, 16, 24]) {
      const value = word.repeat(count).trim();
      const request = await requestFor(pdf, [
        textField('single', 'agent', { value }),
        textField('block', 'agent', { value, multiline: true, placement: { kind: 'rect', ...block } }),
      ]);
      const outcome = await resolveRequest(pdf, request).catch((e: unknown) => e);
      if (outcome instanceof SignPdfError) {
        expect(outcome.code).toBe('value-does-not-fit');
        continue;
      }
      const { text } = await inspectPdf((await finalizeDocument(pdf, outcome as ResolvedRequest, humanInput())).pdf);
      expect(text.length).toBeGreaterThan(1);
      for (const run of text) expectInside(run, run.y < 350 ? single : block);
    }
    // 24 words (119 characters) need less than the minimum size on one line: the loop saw a rejection.
    const tooLong = await failure(
      resolveRequest(pdf, await requestFor(pdf, [textField('single', 'agent', { value: word.repeat(24).trim() })])),
    );
    expect(tooLong.code).toBe('value-does-not-fit');
  });
});

describe('characters the font cannot draw', () => {
  it('are rejected by resolveRequest and named in the message', async () => {
    const pdf = await blankPdf();
    const cjk = await failure(resolveRequest(pdf, await requestFor(pdf, [textField('name', 'agent', { value: '示例 name' })])));
    expect(cjk.code).toBe('unsupported-characters');
    expect(cjk.fieldId).toBe('name');
    expect(cjk.message).toContain('"示" (U+793A)');
    expect(cjk.message).toContain('"例" (U+4F8B)');

    const emoji = await failure(resolveRequest(pdf, await requestFor(pdf, [textField('mood', 'agent', { value: 'ok 😀' })])));
    expect(emoji.code).toBe('unsupported-characters');
    expect(emoji.message).toContain('U+1F600');
  });

  it('are rejected by finalizeDocument, so the audit never records text that was not drawn', async () => {
    const pdf = await blankPdf();
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [textField('name', 'human')]));
    const error = await failure(finalizeDocument(pdf, resolved, humanInput({ values: { name: '示例' } })));
    expect(error.code).toBe('unsupported-characters');
    expect(error.fieldId).toBe('name');
  });

  it('are judged against the font the caller supplies', async () => {
    const pdf = await blankPdf();
    const font = otherFont();
    const box = { page: 1, x: 72, y: 300, width: 200, height: 20 };
    const arrows = await requestFor(pdf, [textField('route', 'agent', { value: 'A → B' })]);

    // The bundled font has no arrow; the supplied font has.
    expect((await failure(resolveRequest(pdf, arrows))).code).toBe('unsupported-characters');
    const resolved = await resolveRequest(pdf, arrows, { font });
    expect((await failure(finalizeDocument(pdf, resolved, humanInput()))).code).toBe('unsupported-characters');
    const result = await finalizeDocument(pdf, resolved, humanInput(), { font });
    const { text } = await inspectPdf(result.pdf);
    expectInside(text.find((item) => item.text === 'A → B'), box);

    // And the reverse: a letter the bundled font has and the supplied font lacks.
    const cyrillic = await requestFor(pdf, [textField('word', 'agent', { value: 'Ԁ' })]);
    await expect(resolveRequest(pdf, cyrillic)).resolves.toBeDefined();
    const error = await failure(resolveRequest(pdf, cyrillic, { font }));
    expect(error.code).toBe('unsupported-characters');
    expect(error.message).toContain('U+0500');
  });
});

describe('checkFieldValue', () => {
  const box = { width: 200, height: 20 };

  it('accepts a value that can be drawn and returns it as it will be recorded', async () => {
    expect(await checkFieldValue({ type: 'text' }, box, 'Ada\u200b Example\u0007')).toEqual({ ok: true, value: 'Ada Example' });
    expect(await checkFieldValue({ type: 'text' }, box, 'two\nlines')).toEqual({ ok: true, value: 'two lines' });
    expect(await checkFieldValue({ type: 'text', multiline: true }, { width: 200, height: 40 }, 'two\r\nlines')).toEqual({
      ok: true,
      value: 'two\nlines',
    });
    expect(await checkFieldValue({ type: 'date' }, box, '2031-03-04')).toEqual({ ok: true, value: '2031-03-04' });
    expect(await checkFieldValue({ type: 'checkbox' }, box, false)).toEqual({ ok: true, value: false });
    expect(await checkFieldValue({ type: 'text' }, box, '')).toEqual({ ok: true, value: '' });
  });

  it('reports the same codes finalizeDocument throws', async () => {
    expect(await checkFieldValue({ type: 'text' }, box, 'x'.repeat(400))).toMatchObject({ ok: false, code: 'value-does-not-fit' });
    expect(await checkFieldValue({ type: 'text', fontSize: 30 }, { width: 200, height: 3 }, 'x')).toMatchObject({
      ok: false,
      code: 'value-does-not-fit',
    });
    expect(await checkFieldValue({ type: 'text' }, box, '示例')).toMatchObject({ ok: false, code: 'unsupported-characters' });
    expect(await checkFieldValue({ type: 'text' }, box, 'A → B')).toMatchObject({ ok: false, code: 'unsupported-characters' });
    expect(await checkFieldValue({ type: 'text' }, box, 'A → B', { font: otherFont() })).toEqual({ ok: true, value: 'A → B' });
    expect(await checkFieldValue({ type: 'text' }, box, true)).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(await checkFieldValue({ type: 'date' }, box, 'tomorrow')).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(await checkFieldValue({ type: 'checkbox' }, box, 'yes')).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(await checkFieldValue({ type: 'signature' }, box, 'Ada Example')).toMatchObject({ ok: false, code: 'invalid-request' });
  });
});

describe('the audit records what was drawn', () => {
  it('stores cleaned text and compares cleaned text', async () => {
    const pdf = await blankPdf();
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [
        textField('company', 'agent', { value: 'Example\u200b Co' }),
        textField('city', 'human', { placement: rect(1, 72, 340, 200, 20) }),
        textField('note', 'human', { placement: rect(1, 72, 380, 200, 20), required: false }),
      ]),
    );
    const result = await finalizeDocument(
      pdf,
      resolved,
      humanInput({ values: { company: 'Example Co', city: 'Spring\u200bfield\u0007\u202e', note: 'one\ntwo' } }),
    );
    const audit = Object.fromEntries(result.audit.fields.map((field) => [field.id, field]));
    // The human's text equals the agent's once both are cleaned: not a change.
    expect(audit.company).toMatchObject({ value: 'Example Co', filledBy: 'agent', changedByHuman: false });
    expect(audit.city).toMatchObject({ value: 'Springfield', filledBy: 'human' });
    expect(audit.note).toMatchObject({ value: 'one two' });
    const drawn = (await inspectPdf(result.pdf)).text.map((item) => item.text);
    expect(drawn).toEqual(['Example Co', 'Springfield', 'one two']);
  });
});

describe('finalizeDocument input validation', () => {
  it('rejects malformed input with invalid-request, never a raw TypeError', async () => {
    const pdf = await blankPdf();
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 72, 300, 150, 60) }]),
    );
    const good = humanInput({ signatures: { sig: { png: makePng(20, 10), method: 'drawn' } } });
    await expect(finalizeDocument(pdf, resolved, good)).resolves.toBeDefined();

    // Each of these is what an untyped caller could send.
    const bad: Array<[string, unknown]> = [
      ['values', { ...good, values: undefined }],
      ['signatures', { ...good, signatures: undefined }],
      ['signatures.sig.png', { ...good, signatures: { sig: { method: 'drawn' } } }],
      ['signatures.sig.png', { ...good, signatures: { sig: { png: [137, 80, 78, 71], method: 'drawn' } } }],
      ['signatures.sig.method', { ...good, signatures: { sig: { png: makePng(2, 2), method: 'stamped' } } }],
      ['signerName', { ...good, signerName: 42 }],
      ['consent', { ...good, consent: undefined }],
      ['consent.acceptedAt', { ...good, consent: { text: 'I agree.', acceptedAt: 'now' } }],
      ['rects.sig', { ...good, rects: { sig: { page: 1, x: 0, y: 0, width: -5, height: 10 } } }],
      ['values.sig', { ...good, values: { sig: 7 } }],
      ['Unrecognized key', { ...good, extra: true }],
      ['Invalid signing input', null],
    ];
    for (const [where, input] of bad) {
      const error = await failure(finalizeDocument(pdf, resolved, input as HumanInput));
      expect(error.code, where).toBe('invalid-request');
      expect(error.message, where).toContain(where);
    }

    for (const broken of [null, {}, { request: resolved.request }, { ...resolved, fields: 'none' }]) {
      const error = await failure(finalizeDocument(pdf, broken as unknown as ResolvedRequest, good));
      expect(error.code).toBe('invalid-request');
    }
  });
});

describe('input limits', () => {
  it('exports the limits', () => {
    expect(MAX_PDF_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_SIGNATURE_IMAGE_SIDE).toBe(4096);
    expect(MAX_PACKET_CHARS).toBeGreaterThan((MAX_PDF_BYTES / 3) * 4);
  });

  it('rejects an oversized signature image from its header, before decoding', async () => {
    const pdf = await blankPdf();
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 72, 300, 150, 60) }]),
    );
    const attempt = (png: Uint8Array) =>
      failure(finalizeDocument(pdf, resolved, humanInput({ signatures: { sig: { png, method: 'uploaded' } } })));

    const started = performance.now();
    const huge = await attempt(makePngHeaderOnly(20000, 20000));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(huge.code).toBe('invalid-request');
    expect(huge.fieldId).toBe('sig');
    expect(huge.message).toContain('20000 x 20000');

    expect((await attempt(makePng(MAX_SIGNATURE_IMAGE_SIDE + 1, 1))).message).toContain('limit');
    // At the limit on one side is fine.
    await expect(
      finalizeDocument(
        pdf,
        resolved,
        humanInput({ signatures: { sig: { png: makePng(MAX_SIGNATURE_IMAGE_SIDE, 2), method: 'uploaded' } } }),
      ),
    ).resolves.toBeDefined();
    // A header with no pixels behind it is not a usable image.
    expect((await attempt(makePngHeaderOnly(100, 40))).code).toBe('invalid-request');
  });

  it('rejects a PDF over the size limit at every entry point', async () => {
    const pdf = await blankPdf();
    const request = await requestFor(pdf, [
      { id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 72, 300, 150, 60) },
    ]);
    const resolved = await resolveRequest(pdf, request);
    const tooBig = new Uint8Array(MAX_PDF_BYTES + 1);

    const errors = [
      await failure(inspectPdf(tooBig)),
      await failure(resolveRequest(tooBig, request)),
      await failure(createPacket(tooBig, request)),
      await failure(verifySignedPdf(tooBig)),
      await failure(finalizeDocument(tooBig, resolved, humanInput())),
    ];
    for (const error of errors) {
      expect(error.code).toBe('invalid-pdf');
      expect(error.message).toContain('too large');
      expect(error.message).toContain('100 MB');
    }
  });

  it('rejects an oversized packet before parsing it', async () => {
    const started = performance.now();
    const error = await failure(decodePacket('x'.repeat(MAX_PACKET_CHARS + 1)));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(error.code).toBe('invalid-packet');
    expect(error.message).toContain('too large');
  });
});

describe('verifySignedPdf', () => {
  it('reports an audit record as an unauthenticated claim', async () => {
    const pdf = await blankPdf();
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 72, 300, 150, 60) }]),
    );
    const signed = await finalizeDocument(
      pdf,
      resolved,
      humanInput({ signatures: { sig: { png: makePng(20, 10), method: 'drawn' } } }),
    );

    // Anyone can lift a record from one PDF and attach it to another.
    const unrelated = await PDFDocument.create();
    unrelated.addPage([200, 200]);
    await unrelated.attach(new TextEncoder().encode(JSON.stringify(signed.audit)), AUDIT_ATTACHMENT_NAME);
    const result = await verifySignedPdf(await unrelated.save());
    expect(result.hasAuditRecord).toBe(true);
    expect(result.integrity).toBe('unverified');
    expect(result).not.toHaveProperty('signed');
    expect((await verifySignedPdf(signed.pdf)).integrity).toBe('unverified');
  });
});

describe('pdf.js failures', () => {
  it('surface as invalid-pdf', async () => {
    let destroyed = false;
    const failing: PdfjsLike = {
      getDocument: () => ({
        promise: Promise.reject(new TypeError('boom inside pdf.js')),
        destroy: async () => {
          destroyed = true;
        },
      }),
    };
    configurePdfjs(failing);
    const error = await failure(inspectPdf(await blankPdf()));
    expect(error.code).toBe('invalid-pdf');
    expect(error.message).toContain('boom inside pdf.js');
    expect(destroyed).toBe(true);
  });
});

describe('form fields on a rotated page', () => {
  it('draws the value upright in the widget rectangle and removes the field', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const form = doc.getForm();
    form.createTextField('party.name').addToPage(page, { x: 100, y: 200, width: 24, height: 220, borderWidth: 0 });
    form.createCheckBox('party.agree').addToPage(page, { x: 200, y: 200, width: 16, height: 16, borderWidth: 0 });
    page.setRotation(degrees(90));
    const pdf = await doc.save();

    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [
        { id: 'name', type: 'text', assignee: 'agent', value: 'Ada Example', placement: { kind: 'acroField', name: 'party.name' } },
        { id: 'agree', type: 'checkbox', assignee: 'human', placement: { kind: 'acroField', name: 'party.agree' } },
      ]),
    );
    // Native (100..124, 200..420) on a page turned 90: displayed x 200..420, y 100..124.
    const nameRect = { page: 1, x: 200, y: 100, width: 220, height: 24 };
    expect(resolved.fields[0]?.rect).toEqual(nameRect);

    const result = await finalizeDocument(pdf, resolved, humanInput({ values: { agree: true } }));
    const after = await inspectPdf(result.pdf);
    expect(after.acroFields).toEqual([]);
    const run = after.text.find((item) => item.text === 'Ada Example');
    expectInside(run, nameRect);
    // Upright as displayed: a wide, short run, not a tall, narrow one.
    expect(run.width).toBeGreaterThan(run.height * 3);

    const marks = await readPageMarks(result.pdf, 1);
    expect(marks.objects.filter((object) => object.name.startsWith('FlatWidget'))).toEqual([]);
    expect(marks.pathPoints).toHaveLength(3);
    for (const [x, y] of marks.pathPoints) {
      expect(x).toBeGreaterThanOrEqual(200);
      expect(x).toBeLessThanOrEqual(216);
      expect(y).toBeGreaterThanOrEqual(200);
      expect(y).toBeLessThanOrEqual(216);
    }
  });
});

describe('a document with mixed page sizes', () => {
  it('resolves an anchor on a rotated page and writes each field on its own page', async () => {
    const doc = await PDFDocument.create();
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([612, 792]);
    // Stored 400 x 600, shown turned a quarter: 600 x 400. The label reads upright when shown.
    const rotated = doc.addPage([400, 600]);
    rotated.setRotation(degrees(90));
    rotated.drawText('Sign here:', { x: 100, y: 200, size: 10, font: helvetica, rotate: degrees(90) });
    const small = doc.addPage([300, 200]);
    small.setCropBox(20, 20, 260, 160);
    const pdf = await doc.save();
    const labelWidth = helvetica.widthOfTextAtSize('Sign here:', 10);

    const first = { page: 1, x: 400, y: 700, width: 200, height: 20 };
    const third = { page: 3, x: 50, y: 130, width: 200, height: 20 };
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [
        { id: 'first', type: 'text', assignee: 'agent', value: 'On page one', placement: { kind: 'rect', ...first } },
        { id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'anchor', text: 'sign here:', width: 100, height: 30 } },
        { id: 'below', type: 'text', assignee: 'agent', value: 'Under the label', placement: { kind: 'anchor', text: 'Sign here:', align: 'below', width: 150, height: 16 } },
        { id: 'third', type: 'text', assignee: 'agent', value: 'On page three', placement: { kind: 'rect', ...third } },
      ]),
    );
    expect(resolved.pages).toEqual([
      { page: 1, width: 612, height: 792 },
      { page: 2, width: 600, height: 400 },
      { page: 3, width: 260, height: 160 },
    ]);
    // The label's box is displayed at x 200, y 90..100 on page 2.
    const sigRect = resolved.fields[1]?.rect;
    expect(sigRect).toMatchObject({ page: 2, width: 100, height: 30 });
    expect(sigRect?.x).toBeCloseTo(200 + labelWidth, 1);
    expect(sigRect?.y).toBeCloseTo(95 - 15, 1);
    const belowRect = resolved.fields[2]?.rect;
    expect(belowRect?.x).toBeCloseTo(200, 1);
    expect(belowRect?.y).toBeCloseTo(100, 1);
    if (!sigRect || !belowRect) throw new Error('no rect');

    // A rectangle that fits page 1 does not fit the smaller page 3.
    const offPage = await failure(
      resolveRequest(
        pdf,
        await requestFor(pdf, [{ id: 'wide', type: 'text', assignee: 'agent', value: 'x', placement: { kind: 'rect', ...first, page: 3 } }]),
      ),
    );
    expect(offPage.code).toBe('field-out-of-bounds');

    const result = await finalizeDocument(
      pdf,
      resolved,
      humanInput({ signatures: { sig: { png: makePng(200, 50), method: 'drawn' } } }),
    );
    const after = await inspectPdf(result.pdf);
    expect(after.pages.map(({ page, width, height }) => ({ page, width, height }))).toEqual(resolved.pages);
    const run = (value: string) => after.text.find((item) => item.text === value);
    expectInside(run('On page one'), first);
    expectInside(run('Under the label'), belowRect);
    expectInside(run('On page three'), third);

    // The image (100 x 25, centred in 100 x 30) is on page 2 only. Turned 90: native x = displayed y, native y = displayed x.
    expect((await readPageMarks(result.pdf, 1)).objects).toEqual([]);
    expect((await readPageMarks(result.pdf, 3)).objects).toEqual([]);
    const image = (await readPageMarks(result.pdf, 2)).objects[0];
    expect(image?.x).toBeCloseTo(sigRect.y + 2.5, 3);
    expect(image?.width).toBeCloseTo(25, 3);
    expect(image?.y).toBeCloseTo(sigRect.x, 3);
    expect(image?.height).toBeCloseTo(100, 3);
  });
});
