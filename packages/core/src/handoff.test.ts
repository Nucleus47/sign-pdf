import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { AUDIT_ATTACHMENT_NAME, HANDOFF_ATTACHMENT_NAME, type FieldInput, type Packet } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from './hash.ts';
import {
  SignPdfError,
  decodeHandoff,
  encodePacket,
  inspectPdf,
  readHandoffPdf,
  resolveRequest,
  verifySignedPdf,
} from './index.ts';
import { buildHandoffPdf, finalizeDocument, type HumanInput } from './sign.ts';
import { humanInput, makePng, requestFor } from './test-helpers.ts';

const rect = (y: number, height = 20) => ({ kind: 'rect', page: 1, x: 72, y, width: 200, height }) as const;

async function twoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Synthetic three-party form', { x: 72, y: 720, size: 12, font });
  doc.addPage([792, 612]).drawText('Second page', { x: 72, y: 500, size: 12, font });
  return doc.save();
}

const fields: FieldInput[] = [
  { id: 'ref', type: 'text', assignee: 'agent', value: 'REF-0001', placement: rect(80) },
  { id: 'sigA', type: 'signature', assignee: 'human', signerId: 'a', placement: rect(120, 40) },
  { id: 'dateA', type: 'date', assignee: 'human', signerId: 'a', placement: rect(170) },
  { id: 'sigB', type: 'signature', assignee: 'human', signerId: 'b', placement: rect(220, 40) },
  { id: 'noteB', type: 'text', assignee: 'human', signerId: 'b', required: false, placement: rect(270) },
  { id: 'sigC', type: 'signature', assignee: 'human', signerId: 'c', placement: rect(320, 40) },
  { id: 'dateC', type: 'date', assignee: 'human', signerId: 'c', placement: rect(370) },
];
const signers = [
  { id: 'a', name: 'Signer One' },
  { id: 'b', name: 'Signer Two' },
  { id: 'c', name: 'Signer Three' },
];

const pass = (signerId: string, day: number, overrides: Partial<HumanInput> = {}): HumanInput =>
  humanInput({
    signerId,
    signerName: `Signer ${signerId.toUpperCase()}`,
    consent: { text: 'I agree to sign this document electronically.', acceptedAt: `2031-03-0${day}T09:59:00.000Z` },
    signedAt: `2031-03-0${day}T10:00:00.000Z`,
    signatures: { [`sig${signerId.toUpperCase()}`]: { png: makePng(40, 10), method: 'drawn' } },
    ...overrides,
  });
const passA = (overrides: Partial<HumanInput> = {}) => pass('a', 4, { values: { ref: 'REF-0002' }, ...overrides });
const passB = (overrides: Partial<HumanInput> = {}) => pass('b', 5, { values: { noteB: 'Second signer note' }, ...overrides });
const passC = () => pass('c', 6);

async function setup() {
  const pdf = await twoPagePdf();
  const resolved = await resolveRequest(pdf, await requestFor(pdf, fields, { signers }));
  return { pdf, resolved };
}

async function failure(promise: Promise<unknown>): Promise<SignPdfError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SignPdfError);
  return error as SignPdfError;
}

/** A PDF that carries the given attachments, for tamper cases. */
async function pdfWith(attachments: [name: string, data: Uint8Array][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  for (const [name, data] of attachments) await doc.attach(data, name, { mimeType: 'application/json' });
  return doc.save();
}
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('buildHandoffPdf and readHandoffPdf', () => {
  it('round-trips, and finalizing after the hand-off gives the same audit record as one session', async () => {
    const { pdf, resolved } = await setup();
    const oneSession = await finalizeDocument(pdf, resolved, [passA(), passB(), passC()]);

    // A hands off to B; B hands off to C; C finalizes. Each device starts from the file alone.
    const first = await buildHandoffPdf(pdf, resolved, [passA()]);
    const atB = await readHandoffPdf(first.pdf);
    if (!atB) throw new Error('no hand-off data');
    expect(atB.pdf).toEqual(pdf);
    expect(atB.packet).toEqual(first.packet);
    expect(atB.passes.map((p) => p.signerId)).toEqual(['a']);

    const resolvedAtB = await resolveRequest(atB.pdf, atB.packet.request);
    const second = await buildHandoffPdf(atB.pdf, resolvedAtB, [...atB.passes, passB()]);
    const atC = await readHandoffPdf(second.pdf);
    if (!atC) throw new Error('no hand-off data');
    const resolvedAtC = await resolveRequest(atC.pdf, atC.packet.request);
    const final = await finalizeDocument(atC.pdf, resolvedAtC, [...atC.passes, passC()]);

    expect(final.audit).toEqual(oneSession.audit);
    expect(final.sha256).toBe(oneSession.sha256);
    expect((await verifySignedPdf(final.pdf)).problems).toEqual([]);
    expect(await readHandoffPdf(final.pdf)).toBeNull();
  });

  it('draws no stamp, attaches the packet, and writes no audit record', async () => {
    const { pdf, resolved } = await setup();
    const { pdf: handoff, packet } = await buildHandoffPdf(pdf, resolved, [passA()]);
    expect(packet.passes).toHaveLength(1);
    expect(packet.passes[0]?.signatures.sigA?.method).toBe('drawn');

    const inspection = await inspectPdf(handoff);
    const all = inspection.text.map((item) => item.text).join(' ');
    expect(all).not.toContain('NOT FINAL');
    const pageOne = inspection.text.filter((item) => item.page === 1).map((item) => item.text).join(' ');
    // The finished pass and the agent's value are drawn; the next signers' fields are not.
    expect(pageOne).toContain('REF-0002');
    expect(pageOne).toContain('2031-03-04');
    expect(pageOne).not.toContain('Signer');

    const doc = await PDFDocument.load(handoff);
    const names = doc.getAttachments().map((attachment) => attachment.name);
    expect(names).toEqual([HANDOFF_ATTACHMENT_NAME]);
    expect(names).not.toContain(AUDIT_ATTACHMENT_NAME);
  });

  it('rejects passes that are not a hand-off', async () => {
    const { pdf, resolved } = await setup();
    const cases: [string, HumanInput[], string][] = [
      ['every signer', [passA(), passB(), passC()], 'at least one signer still to sign'],
      ['the wrong order', [passB()], 'at least one signer still to sign'],
      ['an agent field after the first pass', [passA({ values: {} }), passB({ values: { ref: 'REF-0003' } })], 'only the first signing pass'],
      ['another signer’s field', [passA({ values: { noteB: 'x' } })], 'belongs to signer "b"'],
    ];
    for (const [name, passes, message] of cases) {
      const error = await failure(buildHandoffPdf(pdf, resolved, passes));
      expect(error.code, name).toBe('invalid-request');
      expect(error.message, name).toContain(message);
    }
    expect((await failure(buildHandoffPdf(pdf, resolved, []))).code).toBe('invalid-request');
    // The finished signer's own required fields are checked as at signing.
    const unsigned = await failure(buildHandoffPdf(pdf, resolved, [passA({ signatures: {} })]));
    expect(unsigned).toMatchObject({ code: 'missing-required-field', fieldId: 'sigA' });
  });

  it('rejects a request with one signer', async () => {
    const pdf = await twoPagePdf();
    const single = fields.slice(0, 2).map(({ signerId: _, ...field }) => field) as FieldInput[];
    const resolved = await resolveRequest(pdf, await requestFor(pdf, single));
    const input = humanInput({ signatures: { sigA: { png: makePng(40, 10), method: 'drawn' } } });
    const error = await failure(buildHandoffPdf(pdf, resolved, [input]));
    expect(error.message).toContain('no next signer');
  });
});

describe('decodeHandoff (index export)', () => {
  it('reads the packet text a hand-off returns, as the relay carries it, and checks it', async () => {
    const { pdf, resolved } = await setup();
    const { packet } = await buildHandoffPdf(pdf, resolved, [passA()]);
    const decoded = await decodeHandoff(new TextEncoder().encode(encodePacket(packet)));
    expect(decoded.pdf).toEqual(pdf);
    expect(decoded.packet).toEqual(packet);
    expect(decoded.passes.map((p) => p.signerId)).toEqual(['a']);

    expect((await failure(decodeHandoff(new TextEncoder().encode('not json')))).code).toBe('invalid-handoff');
    const changed = { ...packet, pdfBase64: bytesToBase64(new Uint8Array([1, 2, 3])) };
    expect((await failure(decodeHandoff(json(changed)))).code).toBe('invalid-handoff');
  });
});

describe('readHandoffPdf on untrusted files', () => {
  async function handoff() {
    const { pdf, resolved } = await setup();
    return buildHandoffPdf(pdf, resolved, [passA()]);
  }

  it('returns null for a PDF without hand-off data', async () => {
    expect(await readHandoffPdf(await twoPagePdf())).toBeNull();
  });

  it('rejects changed, damaged or doubled hand-off data', async () => {
    const { packet } = await handoff();
    const edit = (change: (copy: Packet & { passes: NonNullable<Packet['passes']> }) => void) => {
      const copy = structuredClone(packet);
      change(copy);
      return json(copy);
    };
    const notPng = btoa('not a png at all');
    const blank = makePng(4, 4, [255, 255, 255, 0]);
    const cases: [string, Uint8Array[], string][] = [
      ['a changed original', [edit((p) => (p.pdfBase64 = btoa('%PDF-1.7 changed')))], 'does not match its request'],
      ['a pass out of order', [edit((p) => (p.passes[0] = { ...p.passes[0]!, signerId: 'b', signatures: {} }))], 'passes.0.signerId'],
      ['every signer done', [edit((p) => p.passes.push({ ...p.passes[0]!, signerId: 'b', signatures: {} }, { ...p.passes[0]!, signerId: 'c', signatures: {} }))], 'fewer passes than signers'],
      ['a signature on a value field', [edit((p) => (p.passes[0]!.signatures.dateA = p.passes[0]!.signatures.sigA!))], 'not a signature or initials field'],
      ['an image that is not a PNG', [edit((p) => (p.passes[0]!.signatures.sigA!.pngBase64 = notPng))], 'not a PNG'],
      ['a blank image', [edit((p) => (p.passes[0]!.signatures.sigA!.pngBase64 = btoa(String.fromCharCode(...blank))))], 'blank'],
      ['no passes', [edit((p) => delete (p as Partial<typeof p>).passes)], 'no finished signer'],
      ['text that is not JSON', [new TextEncoder().encode('{not json')], 'not valid JSON'],
      ['two hand-off attachments', [json(packet), json(packet)], '2 hand-off attachments'],
    ];
    for (const [name, attachments, message] of cases) {
      const file = await pdfWith(attachments.map((data) => [HANDOFF_ATTACHMENT_NAME, data]));
      const error = await failure(readHandoffPdf(file));
      expect(error.code, name).toBe('invalid-handoff');
      expect(error.message, name).toContain(message);
    }
  });

  it('rejects a file that is not a PDF', async () => {
    expect((await failure(readHandoffPdf(new TextEncoder().encode('not a pdf')))).code).toBe('invalid-pdf');
  });
});

describe('verifySignedPdf on a hand-off PDF', () => {
  it('reports the signers who have signed and those still to sign', async () => {
    const { pdf, resolved } = await setup();
    const { pdf: handoff } = await buildHandoffPdf(pdf, resolved, [passA(), passB()]);
    const result = await verifySignedPdf(handoff);
    expect(result.hasAuditRecord).toBe(false);
    expect(result.audit).toBeUndefined();
    expect(result.handoff).toEqual({
      signed: [
        { id: 'a', name: 'Signer A' },
        { id: 'b', name: 'Signer B' },
      ],
      pending: [{ id: 'c', name: 'Signer Three' }],
    });
    expect(result.problems).toEqual([
      'Not final: this is a hand-off PDF. 2 of 3 signers have signed; still to sign: "c".',
    ]);
  });

  it('reports damaged hand-off data as a problem, not a hand-off', async () => {
    const file = await pdfWith([[HANDOFF_ATTACHMENT_NAME, new TextEncoder().encode('{}')]]);
    const result = await verifySignedPdf(file);
    expect(result.handoff).toBeUndefined();
    expect(result.problems[0]).toContain('hand-off data that cannot be used');
    expect(result.problems.join(' ')).toContain(`No ${AUDIT_ATTACHMENT_NAME} attachment`);
  });
});
