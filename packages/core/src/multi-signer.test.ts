import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { AUDIT_ATTACHMENT_NAME, type AuditRecord, type FieldInput } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import { SignPdfError, checkPasses, resolveRequest, verifySignedPdf } from './index.ts';
import { finalizeDocument, type HumanInput } from './sign.ts';
import { humanInput, makePng, requestFor } from './test-helpers.ts';

const rect = (y: number, height = 20) => ({ kind: 'rect', page: 1, x: 72, y, width: 200, height }) as const;

async function plainPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Synthetic two-party form', { x: 72, y: 720, size: 12, font });
  return doc.save();
}

const fields: FieldInput[] = [
  { id: 'ref', type: 'text', assignee: 'agent', value: 'REF-0001', placement: rect(80) },
  { id: 'sigA', type: 'signature', assignee: 'human', signerId: 'a', placement: rect(120, 40) },
  { id: 'dateA', type: 'date', assignee: 'human', signerId: 'a', placement: rect(170) },
  { id: 'sigB', type: 'signature', assignee: 'human', signerId: 'b', placement: rect(220, 40) },
  { id: 'dateB', type: 'date', assignee: 'human', signerId: 'b', placement: rect(270) },
  { id: 'noteB', type: 'text', assignee: 'human', signerId: 'b', required: false, placement: rect(310) },
];
const signers = [
  { id: 'a', name: 'Signer One' },
  { id: 'b', name: 'Signer Two' },
];

const passA = (overrides: Partial<HumanInput> = {}): HumanInput =>
  humanInput({
    signerId: 'a',
    signerName: 'Signer One',
    signedAt: '2031-03-04T10:00:00.000Z',
    signatures: { sigA: { png: makePng(40, 10), method: 'drawn' } },
    ...overrides,
  });
const passB = (overrides: Partial<HumanInput> = {}): HumanInput =>
  humanInput({
    signerId: 'b',
    signerName: 'Signer Two',
    consent: { text: 'I agree to sign this document electronically.', acceptedAt: '2031-03-05T08:59:00.000Z' },
    signedAt: '2031-03-05T09:00:00.000Z',
    signatures: { sigB: { png: makePng(40, 10), method: 'typed' } },
    values: { noteB: 'Second signer note' },
    ...overrides,
  });

async function setup() {
  const pdf = await plainPdf();
  const resolved = await resolveRequest(pdf, await requestFor(pdf, fields, { signers }));
  return { pdf, resolved };
}

/** Sorted-key JSON written independently of the implementation under test. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([p], [q]) => (p < q ? -1 : 1)))
      : inner,
  );
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function failure(promise: Promise<unknown>): Promise<SignPdfError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SignPdfError);
  return error as SignPdfError;
}

async function pdfWithRecord(audit: AuditRecord): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  await doc.attach(new TextEncoder().encode(JSON.stringify(audit)), AUDIT_ATTACHMENT_NAME, { mimeType: 'application/json' });
  return doc.save();
}

describe('finalizeDocument with several signers', () => {
  it('merges one pass per signer and chains the passes in the audit record', async () => {
    const { pdf, resolved } = await setup();
    const result = await finalizeDocument(pdf, resolved, [passA(), passB()]);
    const audit = result.audit;

    expect(audit.signer).toEqual({ name: 'Signer Two' });
    expect(audit.signedAt).toBe('2031-03-05T09:00:00.000Z');
    expect(audit.consent.acceptedAt).toBe('2031-03-05T08:59:00.000Z');

    const byId = Object.fromEntries(audit.fields.map((field) => [field.id, field]));
    // A date with no value gets the day of its own signer's pass.
    expect(byId.dateA?.value).toBe('2031-03-04');
    expect(byId.dateB?.value).toBe('2031-03-05');
    expect(byId.sigA).toMatchObject({ signerId: 'a', signatureMethod: 'drawn' });
    expect(byId.sigB).toMatchObject({ signerId: 'b', signatureMethod: 'typed' });
    expect(byId.noteB).toMatchObject({ signerId: 'b', value: 'Second signer note', filledBy: 'human' });
    expect(byId.ref?.signerId).toBeUndefined();

    const passes = audit.passes ?? [];
    expect(passes.map((pass) => [pass.signerId, pass.signer.name, pass.fieldIds])).toEqual([
      ['a', 'Signer One', ['sigA', 'dateA']],
      ['b', 'Signer Two', ['sigB', 'dateB', 'noteB']],
    ]);
    expect(passes[0]?.previousSha256).toBe(audit.requestSha256);
    expect(passes[1]?.previousSha256).toBe(sha(sortedJson(passes[0])));

    const verified = await verifySignedPdf(result.pdf);
    expect(verified.audit).toEqual(audit);
    expect(verified.problems).toEqual([]);
  });

  it('records the pass that reviewed an agent field', async () => {
    const { pdf, resolved } = await setup();
    const result = await finalizeDocument(pdf, resolved, [passA({ values: { ref: 'REF-0002' } }), passB()]);
    expect(result.audit.fields.find((field) => field.id === 'ref')).toMatchObject({ signerId: 'a', changedByHuman: true });
    expect(result.audit.passes?.[0]?.fieldIds).toEqual(['sigA', 'dateA']);
    expect((await verifySignedPdf(result.pdf)).problems).toEqual([]);
  });

  it('rejects passes that do not match the signers', async () => {
    const { pdf, resolved } = await setup();
    const cases: [string, HumanInput | HumanInput[], string][] = [
      ['one input', passA(), 'one signing pass per signer'],
      ['a missing pass', [passA()], 'one signing pass per signer'],
      ['the wrong order', [passB(), passA()], 'one signing pass per signer'],
      ['a pass without signerId', [passA({ signerId: undefined }), passB()], 'one signing pass per signer'],
      ['another signer’s signature', [passA({ signatures: { sigA: { png: makePng(40, 10), method: 'drawn' }, sigB: { png: makePng(40, 10), method: 'drawn' } } }), passB()], 'belongs to signer "b"'],
      ['another signer’s value', [passA({ values: { noteB: 'x' } }), passB()], 'belongs to signer "b"'],
      ['another signer’s position', [passA(), passB({ rects: { sigA: { page: 1, x: 72, y: 400, width: 200, height: 40 } } })], 'belongs to signer "a"'],
      ['an agent field in two passes', [passA({ values: { ref: 'REF-0002' } }), passB({ rects: { ref: { page: 1, x: 72, y: 400, width: 200, height: 20 } } })], 'only the first signing pass'],
      ['an agent field after the first pass', [passA(), passB({ confirmed: { ref: true } })], 'only the first signing pass'],
      ['an empty name in a pass', [passA({ signerName: ' ' }), passB()], 'signer name is empty'],
    ];
    for (const [name, input, message] of cases) {
      const error = await failure(finalizeDocument(pdf, resolved, input));
      expect(error.code, name).toBe('invalid-request');
      expect(error.message, name).toContain(message);
    }
    // Each signer must still sign their own required fields.
    const unsigned = await failure(finalizeDocument(pdf, resolved, [passA(), passB({ signatures: {} })]));
    expect(unsigned.code).toBe('missing-required-field');
    expect(unsigned.fieldId).toBe('sigB');
  });

  it('keeps single-signer input and output unchanged', async () => {
    const pdf = await plainPdf();
    const single = fields.filter((field) => field.id === 'ref' || field.id === 'sigA').map(({ signerId: _, ...field }) => field);
    const resolved = await resolveRequest(pdf, await requestFor(pdf, single as FieldInput[]));
    const input = passA({ signerId: undefined });
    delete input.signerId;
    const result = await finalizeDocument(pdf, resolved, input);
    const json = JSON.stringify(result.audit);
    expect(json).not.toContain('passes');
    expect(json).not.toContain('signerId');
    // The same one pass given as an array writes the same record.
    expect((await finalizeDocument(pdf, resolved, [input])).audit).toEqual(result.audit);
    // A signerId needs a request with signers.
    const error = await failure(finalizeDocument(pdf, resolved, passA()));
    expect(error.message).toContain('takes no signerId');
  });
});

describe('verifySignedPdf with passes', () => {
  it('reports a broken pass chain and a mismatched last pass', async () => {
    const { pdf, resolved } = await setup();
    const { audit } = await finalizeDocument(pdf, resolved, [passA(), passB()]);

    const edited = structuredClone(audit);
    if (edited.passes?.[0]) edited.passes[0].signer.name = 'Someone Else';
    const chain = await verifySignedPdf(await pdfWithRecord(edited));
    expect(chain.hasAuditRecord).toBe(true);
    expect(chain.problems.join(' ')).toContain('Pass 2 (signer "b") does not follow');

    const top = structuredClone(audit);
    top.signer.name = 'Someone Else';
    expect((await verifySignedPdf(await pdfWithRecord(top))).problems.join(' ')).toContain('do not match its last pass');

    const moved = structuredClone(audit);
    const field = moved.fields.find((candidate) => candidate.id === 'sigA');
    if (field) field.signerId = 'b';
    expect((await verifySignedPdf(await pdfWithRecord(moved))).problems.join(' ')).toContain('Field "sigA"');
  });

  it('reports a field listed twice, an unknown field, and a signer no pass backs', async () => {
    const { pdf, resolved } = await setup();
    const { audit } = await finalizeDocument(pdf, resolved, [passA(), passB()]);
    const problemsOf = async (edit: (record: AuditRecord) => void) => {
      const record = structuredClone(audit);
      edit(record);
      return (await checkPasses(record)).join(' ');
    };
    expect(await problemsOf((record) => record.passes?.[1]?.fieldIds.push('sigA'))).toContain('"sigA" is listed in more than one pass');
    expect(await problemsOf((record) => record.passes?.[0]?.fieldIds.push('ghost'))).toContain('"ghost", which the record does not have');
    // A human field dropped from its pass's list, though it still names that signer.
    expect(await problemsOf((record) => record.passes?.[0]?.fieldIds.splice(0, 1))).toContain('"sigA" names the signer "a", but no pass covers it');
    // An agent field may name the signer whose pass changed it, but only a signer that has a pass.
    expect(await problemsOf((record) => Object.assign(record.fields.find((field) => field.id === 'ref') ?? {}, { signerId: 'b' }))).toBe('');
    expect(await problemsOf((record) => Object.assign(record.fields.find((field) => field.id === 'ref') ?? {}, { signerId: 'z' }))).toContain('"ref" names the signer "z"');
  });
});
