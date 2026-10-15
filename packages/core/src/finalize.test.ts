import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, type PDFPage } from '@cantoo/pdf-lib';
import { AUDIT_ATTACHMENT_NAME, AuditRecord, type FieldInput, type Rect } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import {
  SignPdfError,
  createPacket,
  decodePacket,
  encodePacket,
  inspectPdf,
  resolveRequest,
  sha256Hex,
  verifySignedPdf,
  type TextItem,
} from './index.ts';
import { finalizeDocument } from './sign.ts';
import { humanInput, makePng, readPageMarks, requestFor } from './test-helpers.ts';

const rect = (page: number, x: number, y: number, width: number, height: number) =>
  ({ kind: 'rect', page, x, y, width, height }) as const;

async function plainPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Mutual agreement between Example Co and Sample LLC', { x: 72, y: 720, size: 12, font });
  page.drawText('Signature:', { x: 72, y: 200, size: 12, font });
  return doc.save();
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

async function failure(promise: Promise<unknown>): Promise<SignPdfError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SignPdfError);
  return error as SignPdfError;
}

/** Sorted-key JSON written independently of the implementation under test. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([p], [q]) => (p < q ? -1 : 1)))
      : inner,
  );
}

describe('packets', () => {
  it('round-trips the PDF bytes exactly', async () => {
    const pdf = await plainPdf();
    const request = await requestFor(pdf, [
      { id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 150, 580, 180, 40) },
    ]);
    const packet = await createPacket(pdf, request);
    expect(packet.kind).toBe('sign-pdf-packet');
    expect(packet.request.fields[0]?.required).toBe(true);

    const decoded = await decodePacket(encodePacket(packet));
    expect(decoded.pdf).toEqual(pdf);
    expect(decoded.packet).toEqual(packet);
    expect(await sha256Hex(decoded.pdf)).toBe(request.document.sha256);
  });

  it('round-trips every byte value', async () => {
    const bytes = Uint8Array.from({ length: 70_001 }, (_, i) => (i * 31) % 256);
    const packet = await createPacket(
      bytes,
      await requestFor(bytes, [{ id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 0, 0, 10, 10) }]),
    );
    expect((await decodePacket(encodePacket(packet))).pdf).toEqual(bytes);
  });

  it('refuses to bundle a PDF that does not match the request', async () => {
    const pdf = await plainPdf();
    const request = await requestFor(pdf, [
      { id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 0, 0, 10, 10) },
    ]);
    const other = Uint8Array.from([...pdf, 10]);
    expect((await failure(createPacket(other, request))).code).toBe('hash-mismatch');
  });

  it('detects changed PDF bytes and malformed packets on decode', async () => {
    const pdf = await plainPdf();
    const packet = await createPacket(
      pdf,
      await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 0, 0, 10, 10) }]),
    );
    const other = await createPacket(
      Uint8Array.of(1, 2, 3),
      await requestFor(Uint8Array.of(1, 2, 3), [
        { id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 0, 0, 10, 10) },
      ]),
    );
    const swapped = encodePacket({ ...packet, pdfBase64: other.pdfBase64 });
    expect((await failure(decodePacket(swapped))).code).toBe('hash-mismatch');
    expect((await failure(decodePacket('{not json'))).code).toBe('invalid-packet');
    expect((await failure(decodePacket(JSON.stringify({ ...packet, kind: 'other' })))).code).toBe('invalid-packet');
    expect((await failure(decodePacket(JSON.stringify({ ...packet, pdfBase64: 'not base64!' })))).code).toBe(
      'invalid-packet',
    );
  });
});

describe('finalizeDocument', () => {
  const fields: FieldInput[] = [
    { id: 'company', type: 'text', assignee: 'agent', value: 'Example Co', placement: rect(1, 72, 300, 200, 20) },
    { id: 'title', type: 'text', assignee: 'agent', value: 'Engineer', placement: rect(1, 72, 330, 200, 20) },
    { id: 'city', type: 'text', assignee: 'human', placement: rect(1, 72, 360, 200, 20) },
    { id: 'notes', type: 'text', assignee: 'human', required: false, placement: rect(1, 72, 390, 200, 20) },
    { id: 'agree', type: 'checkbox', assignee: 'human', placement: rect(1, 72, 420, 16, 16) },
    { id: 'optOut', type: 'checkbox', assignee: 'agent', required: false, value: false, placement: rect(1, 100, 420, 16, 16) },
    { id: 'signedOn', type: 'date', assignee: 'human', placement: rect(1, 72, 450, 100, 20) },
    {
      id: 'sig',
      type: 'signature',
      assignee: 'human',
      placement: { kind: 'anchor', text: 'Signature:', width: 150, height: 60 },
    },
    { id: 'initials', type: 'initials', assignee: 'human', required: false, placement: rect(1, 400, 700, 40, 40) },
  ];

  it('writes values, embeds the audit record, and verifies', async () => {
    const pdf = await plainPdf();
    const original = pdf.slice();
    const request = await requestFor(pdf, fields, { title: 'Synthetic agreement' });
    const resolved = await resolveRequest(pdf, request);
    const png = makePng(200, 50);
    const moved = { page: 1, x: 300, y: 330, width: 200, height: 20 };

    const result = await finalizeDocument(
      pdf,
      resolved,
      humanInput({
        values: { title: 'Senior Engineer', city: 'Springfield', agree: true, company: 'Example Co' },
        signatures: { sig: { png, method: 'drawn' } },
        rects: { title: moved },
      }),
    );

    expect(pdf).toEqual(original);
    expect(result.sha256).toBe(await sha256Hex(result.pdf));
    expect(AuditRecord.parse(result.audit)).toEqual(result.audit);
    expect(result.audit).toMatchObject({
      version: 1,
      app: { name: 'sign-pdf' },
      document: { name: 'fixture.pdf', originalSha256: await sha256Hex(pdf) },
      signer: { name: 'Ada Example' },
      consent: { text: 'I agree to sign this document electronically.', acceptedAt: '2031-03-04T09:59:00.000Z' },
      signedAt: '2031-03-04T10:00:00.000Z',
    });
    expect(result.audit.requestSha256).toBe(
      createHash('sha256').update(sortedJson(resolved.request)).digest('hex'),
    );

    const audit = Object.fromEntries(result.audit.fields.map((field) => [field.id, field]));
    // Echoing the agent's value back unchanged is not a change.
    expect(audit.company).toMatchObject({ filledBy: 'agent', changedByHuman: false, movedByHuman: false, value: 'Example Co' });
    expect(audit.title).toMatchObject({ filledBy: 'human', changedByHuman: true, movedByHuman: true, value: 'Senior Engineer', rect: moved });
    expect(audit.city).toMatchObject({ assignee: 'human', filledBy: 'human', changedByHuman: false, value: 'Springfield' });
    expect(audit.notes).toMatchObject({ filledBy: 'human', changedByHuman: false });
    expect(audit.notes).not.toHaveProperty('value');
    expect(audit.agree).toMatchObject({ filledBy: 'human', value: true });
    expect(audit.optOut).toMatchObject({ filledBy: 'agent', value: false });
    // A human date field with no value takes the signing date.
    expect(audit.signedOn).toMatchObject({ filledBy: 'human', value: '2031-03-04' });
    expect(audit.sig).toMatchObject({
      type: 'signature',
      filledBy: 'human',
      signatureMethod: 'drawn',
      signatureSha256: await sha256Hex(png),
    });
    expect(audit.sig).not.toHaveProperty('value');
    expect(audit.initials).not.toHaveProperty('signatureSha256');

    // The values are on the page, inside their rectangles.
    const { text } = await inspectPdf(result.pdf);
    const run = (value: string) => text.find((item) => item.text === value);
    expectInside(run('Example Co'), { page: 1, x: 72, y: 300, width: 200, height: 20 });
    expectInside(run('Senior Engineer'), moved);
    expectInside(run('Springfield'), { page: 1, x: 72, y: 360, width: 200, height: 20 });
    expectInside(run('2031-03-04'), { page: 1, x: 72, y: 450, width: 100, height: 20 });
    expect(run('Engineer')).toBeUndefined();
    // Left padding 2; 12 pt text sits on the bottom edge of a 20 pt box, a descender's depth (3 pt) above it.
    expect(run('Example Co')?.x).toBeCloseTo(74, 1);
    expect((run('Example Co')?.y ?? 0) + (run('Example Co')?.height ?? 0)).toBeCloseTo(320 - 12 * 0.25, 1);

    // The check mark for "agree" (displayed 72..88, 420..436) is drawn; "optOut" (false) is not.
    const marks = await readPageMarks(result.pdf, 1);
    const inAgree = marks.pathPoints.filter(([x, y]) => x >= 72 && x <= 88 && y >= 792 - 436 && y <= 792 - 420);
    expect(inAgree.length).toBe(3);
    expect(marks.pathPoints.filter(([x, y]) => x >= 100 && x <= 116 && y >= 792 - 436 && y <= 792 - 420)).toEqual([]);

    const verified = await verifySignedPdf(result.pdf);
    expect(verified).toEqual({
      hasAuditRecord: true,
      integrity: 'unverified',
      audit: result.audit,
      sha256: result.sha256,
      problems: [],
    });
  });

  it('scales a signature PNG to fit its rectangle, keeping the aspect ratio', async () => {
    const pdf = await plainPdf();
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [fields[7] as FieldInput]));
    const sigRect = resolved.fields[0]?.rect;
    if (!sigRect) throw new Error('no rect');
    const result = await finalizeDocument(
      pdf,
      resolved,
      humanInput({ signatures: { sig: { png: makePng(200, 50), method: 'typed' } } }),
    );
    const images = (await readPageMarks(result.pdf, 1)).objects;
    expect(images).toHaveLength(1);
    const image = images[0];
    // 200 x 50 into 150 x 60: limited by width, 150 x 37.5, centred vertically.
    expect(image?.width).toBeCloseTo(150, 3);
    expect(image?.height).toBeCloseTo(37.5, 3);
    expect(image?.x).toBeCloseTo(sigRect.x, 3);
    expect(792 - ((image?.y ?? 0) + (image?.height ?? 0))).toBeCloseTo(sigRect.y + (60 - 37.5) / 2, 3);

    // A tall image is limited by height and centred horizontally.
    const tall = await finalizeDocument(
      pdf,
      resolved,
      humanInput({ signatures: { sig: { png: makePng(30, 120), method: 'uploaded' } } }),
    );
    const tallImage = (await readPageMarks(tall.pdf, 1)).objects[0];
    expect(tallImage?.width).toBeCloseTo(15, 3);
    expect(tallImage?.height).toBeCloseTo(60, 3);
    expect(tallImage?.x).toBeCloseTo(sigRect.x + (150 - 15) / 2, 3);
  });

  it('fails loudly when a signature image is not a PNG', async () => {
    const pdf = await plainPdf();
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [fields[7] as FieldInput]));
    const error = await failure(
      finalizeDocument(pdf, resolved, humanInput({ signatures: { sig: { png: Uint8Array.of(1, 2, 3, 4), method: 'uploaded' } } })),
    );
    expect(error.code).toBe('invalid-request');
    expect(error.fieldId).toBe('sig');
  });

  it('requires every required field, the signer name and the consent text', async () => {
    const pdf = await plainPdf();
    const resolved = await resolveRequest(pdf, await requestFor(pdf, fields));
    const complete = {
      values: { city: 'Springfield', agree: true },
      signatures: { sig: { png: makePng(20, 10), method: 'drawn' as const } },
    };
    await expect(finalizeDocument(pdf, resolved, humanInput(complete))).resolves.toBeDefined();

    const noSignature = await failure(finalizeDocument(pdf, resolved, humanInput({ ...complete, signatures: {} })));
    expect(noSignature.code).toBe('missing-required-field');
    expect(noSignature.fieldId).toBe('sig');

    const noCity = await failure(finalizeDocument(pdf, resolved, humanInput({ ...complete, values: { agree: true } })));
    expect(noCity.code).toBe('missing-required-field');
    expect(noCity.fieldId).toBe('city');

    const blankCity = await failure(
      finalizeDocument(pdf, resolved, humanInput({ ...complete, values: { city: '   ', agree: true } })),
    );
    expect(blankCity.fieldId).toBe('city');

    // A required checkbox must be checked: absent and false both block signing.
    const uncheckedValues: Array<Record<string, string | boolean>> = [
      { city: 'Springfield' },
      { city: 'Springfield', agree: false },
    ];
    for (const values of uncheckedValues) {
      const unchecked = await failure(finalizeDocument(pdf, resolved, humanInput({ ...complete, values })));
      expect(unchecked.code).toBe('missing-required-field');
      expect(unchecked.fieldId).toBe('agree');
    }

    // Characters that draw nothing do not count as a value.
    for (const city of ['\u200b\u200d\ufeff', '\u0007\u001b', ' \u00a0\t', '\u202e']) {
      const invisible = await failure(
        finalizeDocument(pdf, resolved, humanInput({ ...complete, values: { city, agree: true } })),
      );
      expect(invisible.code).toBe('missing-required-field');
      expect(invisible.fieldId).toBe('city');
    }

    // Nor does a signature image with nothing to see: transparent, or white only.
    for (const png of [makePng(40, 20, [0, 0, 0, 0]), makePng(40, 20, [255, 255, 255, 255]), makePng(40, 20, [0, 0, 0, 8])]) {
      const blank = await failure(
        finalizeDocument(pdf, resolved, humanInput({ ...complete, signatures: { sig: { png, method: 'drawn' } } })),
      );
      expect(blank.code).toBe('missing-required-field');
      expect(blank.fieldId).toBe('sig');
    }
    // On an optional field a blank image is still refused, never embedded.
    const blankOptional = await failure(
      finalizeDocument(
        pdf,
        resolved,
        humanInput({
          ...complete,
          signatures: { ...complete.signatures, initials: { png: makePng(10, 10, [0, 0, 0, 0]), method: 'drawn' } },
        }),
      ),
    );
    expect(blankOptional.code).toBe('invalid-request');
    expect(blankOptional.fieldId).toBe('initials');

    // Clearing a value the agent supplied leaves a required field empty.
    const cleared = await failure(
      finalizeDocument(pdf, resolved, humanInput({ ...complete, values: { ...complete.values, company: '' } })),
    );
    expect(cleared.code).toBe('missing-required-field');
    expect(cleared.fieldId).toBe('company');

    expect((await failure(finalizeDocument(pdf, resolved, humanInput({ ...complete, signerName: '  ' })))).code).toBe('invalid-request');
    expect(
      (await failure(finalizeDocument(pdf, resolved, humanInput({ ...complete, consent: { text: '', acceptedAt: '2031-03-04T09:59:00.000Z' } })))).code,
    ).toBe('invalid-request');
  });

  it('records which request values the human reviewed and kept', async () => {
    const pdf = await plainPdf();
    const suggested: FieldInput[] = [
      { id: 'kept', type: 'text', assignee: 'human', value: 'Springfield', placement: rect(1, 72, 300, 200, 20) },
      { id: 'echoed', type: 'text', assignee: 'human', value: 'Shelbyville', placement: rect(1, 72, 330, 200, 20) },
      { id: 'edited', type: 'text', assignee: 'human', value: 'Ogdenville', placement: rect(1, 72, 360, 200, 20) },
      { id: 'unreviewed', type: 'text', assignee: 'human', value: 'Capital City', placement: rect(1, 72, 390, 200, 20) },
      { id: 'tick', type: 'checkbox', assignee: 'human', value: true, placement: rect(1, 72, 420, 16, 16) },
      { id: 'own', type: 'text', assignee: 'human', placement: rect(1, 72, 450, 200, 20) },
      { id: 'agentSet', type: 'text', assignee: 'agent', value: 'Brockway', placement: rect(1, 72, 480, 200, 20) },
      { id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 72, 600, 150, 60) },
    ];
    const resolved = await resolveRequest(pdf, await requestFor(pdf, suggested));
    const signatures = { sig: { png: makePng(20, 10), method: 'drawn' as const } };
    const result = await finalizeDocument(
      pdf,
      resolved,
      humanInput({
        values: { echoed: 'Shelbyville', edited: 'North Haverbrook', tick: true, own: 'Brockway' },
        signatures,
        confirmed: { kept: true, echoed: true, edited: true, tick: true },
      }),
    );
    expect(AuditRecord.parse(result.audit)).toEqual(result.audit);
    const audit = Object.fromEntries(result.audit.fields.map((field) => [field.id, field]));
    expect(audit.kept).toMatchObject({ filledBy: 'agent', changedByHuman: false, confirmedByHuman: true, value: 'Springfield' });
    expect(audit.echoed).toMatchObject({ filledBy: 'agent', changedByHuman: false, confirmedByHuman: true });
    // An edit is a change, not a confirmation.
    expect(audit.edited).toMatchObject({ filledBy: 'human', changedByHuman: true, confirmedByHuman: false });
    // A request value nobody reviewed stays distinguishable from a kept one.
    expect(audit.unreviewed).toMatchObject({ filledBy: 'agent', changedByHuman: false, confirmedByHuman: false, value: 'Capital City' });
    expect(audit.tick).toMatchObject({ filledBy: 'agent', confirmedByHuman: true, value: true });
    expect(audit.own).toMatchObject({ filledBy: 'human', confirmedByHuman: false });
    expect(audit.sig).toMatchObject({ confirmedByHuman: false });

    // Only a human field with a request value can be confirmed, and only a field in the request.
    for (const id of ['own', 'sig', 'agentSet', 'missing']) {
      const confirmed: Record<string, true> = { [id]: true };
      const error = await failure(finalizeDocument(pdf, resolved, humanInput({ values: { own: 'Brockway' }, signatures, confirmed })));
      expect(error.code).toBe('invalid-request');
    }
  });

  it('rejects input that does not fit the request', async () => {
    const pdf = await plainPdf();
    const resolved = await resolveRequest(pdf, await requestFor(pdf, fields));
    const base = { values: { city: 'Springfield', agree: true }, signatures: { sig: { png: makePng(20, 10), method: 'drawn' as const } } };
    const attempt = (overrides: Parameters<typeof humanInput>[0]) => failure(finalizeDocument(pdf, resolved, humanInput({ ...base, ...overrides })));

    expect((await attempt({ values: { ...base.values, unknown: 'x' } })).code).toBe('invalid-request');
    expect((await attempt({ values: { ...base.values, agree: 'yes' } })).fieldId).toBe('agree');
    expect((await attempt({ values: { ...base.values, signedOn: '04/03/2031' } })).fieldId).toBe('signedOn');
    // A signature can never arrive as a value, nor a value field take an image.
    expect((await attempt({ values: { ...base.values, sig: 'Ada Example' } })).fieldId).toBe('sig');
    expect((await attempt({ signatures: { ...base.signatures, city: { png: makePng(2, 2), method: 'drawn' } } })).fieldId).toBe('city');
    const offPage = await attempt({ rects: { city: { page: 1, x: 500, y: 360, width: 200, height: 20 } } });
    expect(offPage.code).toBe('field-out-of-bounds');
    expect(offPage.fieldId).toBe('city');
    expect((await attempt({ rects: { city: { page: 4, x: 0, y: 0, width: 10, height: 10 } } })).code).toBe('page-out-of-range');
    expect((await attempt({ signedAt: 'yesterday' })).code).toBe('invalid-request');

    const otherPdf = Uint8Array.from([...pdf, 10]);
    expect((await failure(finalizeDocument(otherPdf, resolved, humanInput(base)))).code).toBe('hash-mismatch');
  });

  it('draws non-Latin text without throwing', async () => {
    const pdf = await plainPdf();
    const value = 'Жанна Ελένη Þórður';
    const box = { page: 1, x: 72, y: 300, width: 300, height: 24 };
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [{ id: 'name', type: 'text', assignee: 'agent', value, placement: { kind: 'rect', ...box } }]),
    );
    const result = await finalizeDocument(pdf, resolved, humanInput());
    const { text } = await inspectPdf(result.pdf);
    expectInside(text.find((item) => item.text === value), box);

  });

  it('shrinks text that is too wide and wraps multiline text', async () => {
    const pdf = await plainPdf();
    const narrow = { page: 1, x: 72, y: 300, width: 90, height: 20 };
    const block = { page: 1, x: 72, y: 400, width: 120, height: 60 };
    const long = 'A fairly long value for a narrow box';
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [
        { id: 'narrow', type: 'text', assignee: 'agent', value: long, fontSize: 14, placement: { kind: 'rect', ...narrow } },
        {
          id: 'block',
          type: 'text',
          assignee: 'agent',
          multiline: true,
          fontSize: 10,
          value: 'First line\nSecond line that has to wrap around',
          placement: { kind: 'rect', ...block },
        },
      ]),
    );
    const { text } = await inspectPdf((await finalizeDocument(pdf, resolved, humanInput())).pdf);

    const shrunk = text.find((item) => item.text === long);
    expectInside(shrunk, narrow);
    expect(shrunk.height).toBeLessThan(14);

    const lines = text.filter((item) => item.y >= block.y && item.y < block.y + block.height && item.x < 200);
    expect(lines.map((item) => item.text)).toEqual(['First line', 'Second line that has to', 'wrap around']);
    for (const line of lines) expectInside(line, block);
    expect(lines[0]?.height).toBeCloseTo(10, 1);
    expect((lines[1]?.y ?? 0) - (lines[0]?.y ?? 0)).toBeCloseTo(12, 1);
  });

  it('fills real form fields for acroField placements and flattens only those', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    form.createTextField('applicant.name').addToPage(page, { x: 72, y: 600, width: 220, height: 22, borderWidth: 0 });
    form.createCheckBox('applicant.agree').addToPage(page, { x: 72, y: 560, width: 14, height: 14, borderWidth: 0 });
    form.createTextField('untouched').addToPage(page, { x: 72, y: 500, width: 220, height: 22, borderWidth: 0 });
    form.createDropdown('country').addToPage(page, { x: 72, y: 440, width: 220, height: 22, borderWidth: 0 });
    const pdf = await doc.save();

    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [
        { id: 'name', type: 'text', assignee: 'agent', value: 'Zoë Пример', placement: { kind: 'acroField', name: 'applicant.name' } },
        { id: 'agree', type: 'checkbox', assignee: 'human', placement: { kind: 'acroField', name: 'applicant.agree' } },
        // A text value on a dropdown is drawn into the widget's rectangle; the dropdown stays.
        { id: 'country', type: 'text', assignee: 'agent', value: 'Freedonia', placement: { kind: 'acroField', name: 'country' } },
      ]),
    );
    const nameRect = { page: 1, x: 72, y: 792 - 600 - 22, width: 220, height: 22 };
    expect(resolved.fields[0]?.rect).toEqual(nameRect);

    const result = await finalizeDocument(pdf, resolved, humanInput({ values: { agree: true } }));
    const after = await inspectPdf(result.pdf);
    expect(after.acroFields.map((field) => field.name)).toEqual(['untouched', 'country']);
    expectInside(after.text.find((item) => item.text === 'Zoë Пример'), nameRect);
    expectInside(after.text.find((item) => item.text === 'Freedonia'), { page: 1, x: 72, y: 792 - 440 - 22, width: 220, height: 22 });

    // The flattened appearances are painted at the widgets' native positions.
    const painted = (await readPageMarks(result.pdf, 1)).objects.filter((object) => object.name.startsWith('FlatWidget'));
    expect(painted.map(({ x, y }) => [x, y])).toEqual([
      [72, 600],
      [72, 560],
    ]);
    expect(result.audit.fields.map((field) => field.value)).toEqual(['Zoë Пример', true, 'Freedonia']);
    expect((await verifySignedPdf(result.pdf)).hasAuditRecord).toBe(true);
  });

  /** Stored page 400 wide and 600 high unless `prepare` says otherwise. `box` is the visible native box. */
  interface PageCase {
    name: string;
    rotation: 0 | 90 | 180 | 270;
    box: readonly [number, number, number, number];
    unit?: number;
    displayed: readonly [number, number];
    prepare?: (page: PDFPage) => void;
  }
  const crop = (page: PDFPage) => page.setCropBox(40, 60, 300, 500);
  const cases: PageCase[] = [
    { name: 'rotated 90', rotation: 90, box: [0, 0, 400, 600], displayed: [600, 400] },
    { name: 'rotated 180', rotation: 180, box: [0, 0, 400, 600], displayed: [400, 600] },
    { name: 'rotated 270', rotation: 270, box: [0, 0, 400, 600], displayed: [600, 400] },
    { name: 'cropped', rotation: 0, box: [40, 60, 300, 500], displayed: [300, 500], prepare: crop },
    { name: 'cropped and rotated 90', rotation: 90, box: [40, 60, 300, 500], displayed: [500, 300], prepare: crop },
    { name: 'cropped and rotated 270', rotation: 270, box: [40, 60, 300, 500], displayed: [500, 300], prepare: crop },
    {
      name: 'on a media box with a non-zero origin',
      rotation: 0,
      box: [100, 200, 400, 600],
      displayed: [400, 600],
      prepare: (page) => page.setMediaBox(100, 200, 400, 600),
    },
    {
      name: 'on a non-zero media box origin, rotated 90',
      rotation: 90,
      box: [100, 200, 400, 600],
      displayed: [600, 400],
      prepare: (page) => page.setMediaBox(100, 200, 400, 600),
    },
    {
      // Corners given top-right first: [400 600 0 0].
      name: 'on an inverted media box',
      rotation: 0,
      box: [0, 0, 400, 600],
      displayed: [400, 600],
      prepare: (page) => page.node.set(PDFName.of('MediaBox'), page.doc.context.obj([400, 600, 0, 0])),
    },
    {
      name: 'scaled by UserUnit 2',
      rotation: 0,
      box: [0, 0, 400, 600],
      unit: 2,
      displayed: [800, 1200],
      prepare: (page) => page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2)),
    },
    {
      name: 'scaled by UserUnit 2, cropped and rotated 270',
      rotation: 270,
      box: [40, 60, 300, 500],
      unit: 2,
      displayed: [1000, 600],
      prepare: (page) => {
        crop(page);
        page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
      },
    },
  ];

  describe.each(cases)('on a page that is $name', ({ rotation, box, unit = 1, displayed, prepare }) => {
    /** Displayed point to PDF-native, written out per rotation from the PDF specification. */
    function toNative(displayX: number, displayY: number): [number, number] {
      const [x0, y0, w, h] = box;
      const x = displayX / unit;
      const y = displayY / unit;
      if (rotation === 90) return [x0 + y, y0 + x];
      if (rotation === 180) return [x0 + w - x, y0 + y];
      if (rotation === 270) return [x0 + w - y, y0 + h - x];
      return [x0 + x, y0 + h - y];
    }

    it('lands text and a signature where they were placed', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 600]);
      page.setRotation(degrees(rotation));
      prepare?.(page);
      const pdf = await doc.save();

      const textBox = { page: 1, x: 60, y: 50, width: 200, height: 20 };
      const sigBox = { page: 1, x: 100, y: 120, width: 150, height: 60 };
      const resolved = await resolveRequest(
        pdf,
        await requestFor(pdf, [
          { id: 'label', type: 'text', assignee: 'agent', value: 'Placed here', placement: { kind: 'rect', ...textBox } },
          { id: 'tick', type: 'checkbox', assignee: 'agent', value: true, placement: rect(1, 20, 200, 20, 20) },
          { id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'rect', ...sigBox } },
        ]),
      );
      expect(resolved.pages).toEqual([{ page: 1, width: displayed[0], height: displayed[1] }]);

      const result = await finalizeDocument(
        pdf,
        resolved,
        humanInput({ signatures: { sig: { png: makePng(200, 50), method: 'drawn' } } }),
      );

      // Re-inspecting the output puts the text back in the box it was given, upright.
      const { text, pages } = await inspectPdf(result.pdf);
      expect(pages.map(({ page, width, height }) => ({ page, width, height }))).toEqual(resolved.pages);
      const run = text.find((item) => item.text === 'Placed here');
      expectInside(run, textBox);
      expect(run.x).toBeCloseTo(62, 1);
      expect(run.height).toBeCloseTo(12, 1);
      expect(run.width).toBeGreaterThan(run.height * 3);

      // The image sits at the native position the displayed box maps to: 150 x 37.5,
      // centred in the 150 x 60 box, so displayed x 100..250, y 131.25..168.75.
      const marks = await readPageMarks(result.pdf, 1);
      const image = marks.objects[0];
      const [ax, ay] = toNative(100, 131.25);
      const [bx, by] = toNative(250, 168.75);
      expect(image?.x).toBeCloseTo(Math.min(ax, bx), 3);
      expect(image?.y).toBeCloseTo(Math.min(ay, by), 3);
      expect(image?.width).toBeCloseTo(Math.abs(bx - ax), 3);
      expect(image?.height).toBeCloseTo(Math.abs(by - ay), 3);

      // Every stroke of the check mark stays inside its displayed box (20..40, 200..220).
      const [cx0, cy0] = toNative(20, 200);
      const [cx1, cy1] = toNative(40, 220);
      expect(marks.pathPoints).toHaveLength(3);
      for (const [x, y] of marks.pathPoints) {
        expect(x).toBeGreaterThanOrEqual(Math.min(cx0, cx1));
        expect(x).toBeLessThanOrEqual(Math.max(cx0, cx1));
        expect(y).toBeGreaterThanOrEqual(Math.min(cy0, cy1));
        expect(y).toBeLessThanOrEqual(Math.max(cy0, cy1));
      }
    });
  });
});

describe('verifySignedPdf', () => {
  it('reports an unsigned PDF without throwing', async () => {
    const pdf = await plainPdf();
    const result = await verifySignedPdf(pdf);
    expect(result.hasAuditRecord).toBe(false);
    expect(result.integrity).toBe('unverified');
    expect(result.audit).toBeUndefined();
    expect(result.sha256).toBe(await sha256Hex(pdf));
    expect(result.problems).toHaveLength(1);
  });

  it('reports a malformed audit record', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await doc.attach(new TextEncoder().encode(JSON.stringify({ version: 1, signer: {} })), AUDIT_ATTACHMENT_NAME, {
      mimeType: 'application/json',
    });
    const result = await verifySignedPdf(await doc.save());
    expect(result.hasAuditRecord).toBe(false);
    expect(result.integrity).toBe('unverified');
    expect(result.audit).toBeUndefined();
    expect(result.problems.join(' ')).toContain('malformed');
    expect(result.problems.join(' ')).toContain('signer.name');

    const broken = await PDFDocument.create();
    broken.addPage();
    await broken.attach(new TextEncoder().encode('{nope'), AUDIT_ATTACHMENT_NAME);
    expect((await verifySignedPdf(await broken.save())).problems).toEqual(['The audit record is not valid JSON.']);
  });

  it('rejects bytes that are not a PDF', async () => {
    expect((await failure(verifySignedPdf(Uint8Array.of(1, 2, 3)))).code).toBe('invalid-pdf');
  });
});
