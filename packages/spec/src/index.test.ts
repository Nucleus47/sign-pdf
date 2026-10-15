import { describe, expect, it } from 'vitest';
import { config } from 'zod';
import {
  AuditRecord,
  MAX_SIGNATURE_PNG_BYTES,
  Packet,
  parseSignRequest,
  safeParseSignRequest,
  signRequestJsonSchema,
} from './index.ts';

const sha256 = 'a'.repeat(64);

const base = {
  version: 1,
  document: { name: 'nda.pdf', sha256 },
  fields: [
    {
      id: 'name',
      type: 'text',
      assignee: 'agent',
      value: 'Ada Example',
      placement: { kind: 'rect', page: 1, x: 72, y: 100, width: 200, height: 16 },
    },
    {
      id: 'sig',
      type: 'signature',
      assignee: 'human',
      placement: { kind: 'anchor', text: 'Signature:', width: 160, height: 48 },
    },
  ],
};

describe('SignRequest', () => {
  it('accepts a valid request and applies defaults', () => {
    const request = parseSignRequest(base);
    expect(request.fields[0]?.required).toBe(true);
    const placement = request.fields[1]?.placement;
    expect(placement).toMatchObject({ kind: 'anchor', align: 'right', occurrence: 1, dx: 0, dy: 0 });
  });

  it('rejects a value on a signature field', () => {
    const request = structuredClone(base) as { fields: Record<string, unknown>[] };
    request.fields[1] = { ...request.fields[1], value: 'data:image/png;base64,AAAA' };
    expect(safeParseSignRequest(request).success).toBe(false);
  });

  it('rejects a signature field assigned to the agent', () => {
    const request = structuredClone(base) as { fields: Record<string, unknown>[] };
    request.fields[1] = { ...request.fields[1], assignee: 'agent' };
    expect(safeParseSignRequest(request).success).toBe(false);
  });

  it('rejects an agent field without a value', () => {
    const request = structuredClone(base) as { fields: Record<string, unknown>[] };
    delete request.fields[0]?.value;
    expect(safeParseSignRequest(request).success).toBe(false);
  });

  it('rejects duplicate field ids', () => {
    const request = structuredClone(base) as { fields: Record<string, unknown>[] };
    request.fields[1] = { ...request.fields[1], id: 'name' };
    expect(safeParseSignRequest(request).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(safeParseSignRequest({ ...base, extra: true }).success).toBe(false);
  });

  it('exports a JSON Schema', () => {
    const schema = signRequestJsonSchema();
    expect(schema).toHaveProperty('properties.fields');
  });
});

describe('SignRequest with signers', () => {
  const signers = [{ id: 'a', name: 'Signer One' }, { id: 'b' }];
  const multi = () => ({
    ...structuredClone(base),
    signers,
    fields: [
      base.fields[0],
      { ...base.fields[1], id: 'sigA', signerId: 'a' },
      { ...base.fields[1], id: 'sigB', signerId: 'b' },
    ],
  });
  const messages = (input: unknown) => {
    const parsed = safeParseSignRequest(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };

  it('accepts a request where every human field names a known signer', () => {
    expect(parseSignRequest(multi()).signers).toEqual(signers);
  });

  it('rejects duplicate signer ids, and signer with signers', () => {
    expect(messages({ ...multi(), signers: [signers[0], signers[0]] })).toContain('duplicate signer id "a"');
    expect(messages({ ...multi(), signer: { name: 'Signer One' } })).toContain('use "signers" or "signer", not both');
  });

  it('rejects a human field without a known signer, and an agent field with one', () => {
    const request = multi();
    delete (request.fields[1] as { signerId?: string }).signerId;
    expect(messages(request)).toContain('a human field needs a signerId when the request has "signers"');
    const unknown = multi();
    (unknown.fields[2] as { signerId: string }).signerId = 'c';
    expect(messages(unknown)).toContain('signerId "c" is not in "signers"');
    const agent = multi();
    agent.fields[0] = { ...base.fields[0], signerId: 'a' } as (typeof agent.fields)[number];
    expect(messages(agent)).toContain('a field assigned to the agent takes no signerId');
  });

  it('rejects signerId without signers, and more than 20 signers', () => {
    const request = structuredClone(base) as { fields: Record<string, unknown>[] };
    request.fields[1] = { ...request.fields[1], signerId: 'a' };
    expect(messages(request)).toContain('signerId needs a "signers" list on the request');
    const many = Array.from({ length: 21 }, (_, index) => ({ id: `s${index}` }));
    expect(safeParseSignRequest({ ...multi(), signers: many }).success).toBe(false);
    expect(safeParseSignRequest({ ...multi(), signers: [] }).success).toBe(false);
  });
});

describe('zod configuration', () => {
  it('turns off the eval probe that a strict content security policy reports', () => {
    expect(config().jitless).toBe(true);
  });
});

describe('AuditRecord', () => {
  const hash = 'a'.repeat(64);
  const field = {
    id: 'city',
    type: 'text',
    assignee: 'human',
    filledBy: 'agent',
    changedByHuman: false,
    movedByHuman: false,
    rect: { page: 1, x: 72, y: 72, width: 200, height: 20 },
    value: 'Springfield',
  };
  const record = (fields: unknown[]) => ({
    version: 1,
    app: { name: 'sign-pdf', version: '0.1.0' },
    document: { name: 'synthetic.pdf', originalSha256: hash },
    requestSha256: hash,
    signer: { name: 'Ada Example' },
    consent: { text: 'I agree.', acceptedAt: '2031-03-04T09:59:00.000Z' },
    signedAt: '2031-03-04T10:00:00.000Z',
    fields,
  });

  it('reads records written before confirmedByHuman existed', () => {
    expect(AuditRecord.parse(record([field])).fields[0]?.confirmedByHuman).toBeUndefined();
  });

  it('reads records without passes and records with them', () => {
    expect(AuditRecord.parse(record([field]))).not.toHaveProperty('passes');
    const pass = {
      signerId: 'a',
      signer: { name: 'Ada Example' },
      consent: { text: 'I agree.', acceptedAt: '2031-03-04T09:59:00.000Z' },
      signedAt: '2031-03-04T10:00:00.000Z',
      fieldIds: ['city'],
      previousSha256: hash,
    };
    const parsed = AuditRecord.parse({ ...record([{ ...field, signerId: 'a' }]), passes: [pass] });
    expect(parsed.passes?.[0]).toEqual(pass);
    expect(parsed.fields[0]?.signerId).toBe('a');
    expect(AuditRecord.safeParse({ ...record([field]), passes: [{ ...pass, previousSha256: 'x' }] }).success).toBe(false);
  });

  it('reads confirmedByHuman and rejects a non-boolean value', () => {
    expect(AuditRecord.parse(record([{ ...field, confirmedByHuman: true }])).fields[0]?.confirmedByHuman).toBe(true);
    expect(AuditRecord.safeParse(record([{ ...field, confirmedByHuman: 'yes' }])).success).toBe(false);
  });
});

describe('Packet passes (hand-off)', () => {
  const at = { kind: 'rect', page: 1, x: 72, y: 100, width: 200, height: 20 } as const;
  const request = {
    version: 1,
    document: { name: 'form.pdf', sha256 },
    signers: [{ id: 'a', name: 'Signer One' }, { id: 'b' }, { id: 'c' }],
    fields: [
      { id: 'ref', type: 'text', assignee: 'agent', value: 'REF-1', placement: at },
      { id: 'sigA', type: 'signature', assignee: 'human', signerId: 'a', placement: at },
      { id: 'noteA', type: 'text', assignee: 'human', signerId: 'a', required: false, placement: at },
      { id: 'sigB', type: 'signature', assignee: 'human', signerId: 'b', placement: at },
      { id: 'sigC', type: 'signature', assignee: 'human', signerId: 'c', placement: at },
    ],
  };
  const png = { pngBase64: 'iVBORw0KGgo=', method: 'drawn' };
  const pass = (signerId: string, extra: Record<string, unknown> = {}) => ({
    signerId,
    signerName: `Signer ${signerId}`,
    consent: { text: 'I agree.', acceptedAt: '2031-03-04T09:59:00.000Z' },
    signedAt: '2031-03-04T10:00:00.000Z',
    values: {},
    signatures: { [`sig${signerId.toUpperCase()}`]: png },
    ...extra,
  });
  const packet = (passes: unknown[] | undefined, extra: Record<string, unknown> = {}) => ({
    kind: 'sign-pdf-packet',
    version: 1,
    request,
    pdfBase64: 'JVBERi0=',
    ...(passes === undefined ? {} : { passes }),
    ...extra,
  });
  const issues = (input: unknown) => {
    const parsed = Packet.safeParse(input);
    return parsed.success ? '' : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  };

  it('accepts a packet without passes and an in-order prefix of the signers', () => {
    expect(issues(packet(undefined))).toBe('');
    expect(issues(packet([pass('a', { values: { ref: 'REF-2', noteA: 'x' }, confirmed: { ref: true } })]))).toBe('');
    expect(issues(packet([pass('a'), pass('b')]))).toBe('');
    expect(Packet.parse(packet([pass('a')])).passes?.[0]?.signatures.sigA).toEqual(png);
  });

  it('rejects passes that are not a strict in-order prefix', () => {
    expect(issues(packet([]))).toContain('passes');
    expect(issues(packet([pass('b')]))).toContain('passes.0.signerId');
    expect(issues(packet([pass('a'), pass('b'), pass('c')]))).toContain('fewer passes than signers');
    const single = { ...request, signers: undefined, fields: [{ ...request.fields[0] }] };
    expect(issues(packet([pass('a', { signatures: {} })], { request: single }))).toContain('need a "signers" list');
  });

  it('keeps each field in the pass that may touch it', () => {
    expect(issues(packet([pass('a', { values: { ghost: 'x' } })]))).toContain('"ghost" is not a field');
    expect(issues(packet([pass('a', { signatures: { sigA: png, sigB: png } })]))).toContain('belongs to signer "b"');
    expect(issues(packet([pass('a'), pass('b', { values: { ref: 'REF-2' } })]))).toContain('only in the first pass');
    expect(issues(packet([pass('a'), pass('b', { rects: { noteA: { page: 1, x: 0, y: 0, width: 1, height: 1 } } })]))).toContain(
      'belongs to signer "a"',
    );
  });

  it('allows signatures only on signing fields, and values never on them', () => {
    expect(issues(packet([pass('a', { signatures: { sigA: png, noteA: png } })]))).toContain('not a signature or initials field');
    expect(issues(packet([pass('a', { values: { sigA: 'drawn' } })]))).toContain('takes no value');
  });

  it('checks the signer details and the signature image encoding', () => {
    expect(issues(packet([pass('a', { signerName: ' ' })]))).toContain('passes.0.signerName');
    expect(issues(packet([pass('a', { extra: true })]))).not.toBe('');
    const bad = (pngBase64: string) => packet([pass('a', { signatures: { sigA: { ...png, pngBase64 } } })]);
    expect(issues(bad('iVBORw0KGgo'))).toContain('base64');
    expect(issues(bad('iVBO Rw0K'))).toContain('base64');
    expect(issues(bad('iVBORw0K-_=='))).toContain('base64');
    expect(issues(bad(''))).not.toBe('');
    expect(issues(bad('A'.repeat((Math.ceil(MAX_SIGNATURE_PNG_BYTES / 3) + 1) * 4)))).toContain('too large');
  });
});
