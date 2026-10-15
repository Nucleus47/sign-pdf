import { readFile } from 'node:fs/promises';
import type { FieldInput } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import { anchorCandidatesOf, inspectPdf, nearestTextMatches, sha256Hex, validateRequestAgainstPdf } from './index.ts';
import { fixturePdf, requestFor } from './test-helpers.ts';

const rect = (page: number, x: number, y: number, width: number, height: number) =>
  ({ kind: 'rect', page, x, y, width, height }) as const;

/** A signature box right of `Signature:` and an agent-filled name. */
const DEFAULT_FIELDS: FieldInput[] = [
  {
    id: 'sig',
    type: 'signature',
    assignee: 'human',
    placement: { kind: 'anchor', text: 'Signature:', align: 'right', dx: 6, width: 180, height: 36 },
  },
  { id: 'name', type: 'text', assignee: 'agent', value: 'Ada Example', placement: rect(1, 72, 300, 200, 20) },
];

async function validate(fields: FieldInput[] = DEFAULT_FIELDS, pdf?: Uint8Array) {
  const bytes = pdf ?? (await fixturePdf());
  return validateRequestAgainstPdf(bytes, await requestFor(bytes, structuredClone(fields)));
}

describe('validateRequestAgainstPdf', () => {
  it('reports the resolved rectangle of every field and returns the resolved request', async () => {
    const { report, resolved } = await validate();
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.pages).toHaveLength(1);
    expect(resolved?.fields.map((field) => field.id)).toEqual(['sig', 'name']);
    const sig = report.fields[0];
    expect(sig).toMatchObject({ id: 'sig', type: 'signature', assignee: 'human', placement: 'anchor', required: true });
    // Right of the "Signature:" label (which ends near x 127), centred on its line.
    expect(sig?.rect.x).toBeGreaterThan(125);
    expect(sig?.rect.x).toBeLessThan(140);
    expect(sig?.rect.y).toBeGreaterThan(545);
    expect((sig?.rect.y ?? 0) + (sig?.rect.height ?? 0)).toBeLessThan(600);
    expect(report.fields[1]?.rect).toEqual({ page: 1, x: 72, y: 300, width: 200, height: 20 });
  });

  it('reports every bad field with a hint, and still resolves the good ones', async () => {
    const { report, resolved } = await validate([
      ...DEFAULT_FIELDS,
      { id: 'when', type: 'date', assignee: 'human', placement: { kind: 'anchor', text: 'Signatures', width: 80, height: 16 } },
      { id: 'who', type: 'text', assignee: 'human', placement: { kind: 'acroField', name: 'fullname' } },
      { id: 'off', type: 'text', assignee: 'human', placement: rect(1, 500, 300, 200, 20) },
      { id: 'far', type: 'text', assignee: 'human', placement: rect(4, 10, 10, 50, 20) },
    ]);
    expect(report.ok).toBe(false);
    expect(resolved).toBeUndefined();
    expect(report.fields.map((field) => field.id)).toEqual(['sig', 'name']);
    const byField = Object.fromEntries(report.errors.map((issue) => [issue.fieldId, issue]));
    expect(Object.keys(byField).sort()).toEqual(['far', 'off', 'when', 'who']);
    expect(byField['when']).toMatchObject({ code: 'anchor-not-found' });
    expect(byField['when']?.nearestText?.[0]).toMatchObject({ text: 'Signature: Date:', page: 1 });
    expect(byField['when']?.hint).toContain('nearestText');
    expect(byField['who']).toMatchObject({ code: 'acro-field-not-found', availableFormFields: ['full_name'] });
    expect(byField['off']).toMatchObject({ code: 'field-out-of-bounds' });
    expect(byField['off']?.hint).toContain('612 x 792');
    expect(byField['far']).toMatchObject({ code: 'page-out-of-range' });
    expect(byField['far']?.hint).toContain('1 page(s)');
  });

  it('says how to fix an anchor whose occurrence is too high', async () => {
    const { report } = await validate([
      { id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'anchor', text: 'signature:', occurrence: 2, width: 80, height: 16 } },
    ]);
    expect(report.errors[0]?.code).toBe('anchor-not-found');
    expect(report.errors[0]?.hint).toContain('occurrence');
  });

  it('warns about an anchor that matches more than one place, lists the candidates, and anchorCandidatesOf returns them', async () => {
    const pdf = await fixturePdf({ pages: 3 });
    const initials = (occurrence?: number): FieldInput[] => [
      ...DEFAULT_FIELDS,
      {
        id: 'ini',
        type: 'initials',
        assignee: 'human',
        placement: { kind: 'anchor', text: 'appendix', width: 40, height: 16, align: 'below', ...(occurrence ? { occurrence } : {}) },
      },
    ];
    const { report } = await validate(initials(), pdf);
    expect(report.ok).toBe(true);
    const warning = report.warnings.find((issue) => issue.code === 'anchor-ambiguous');
    expect(warning).toMatchObject({ fieldId: 'ini', hint: expect.stringContaining('occurrence') });
    expect(warning?.candidates?.map((candidate) => [candidate.page, candidate.text])).toEqual([
      [2, 'Appendix'],
      [3, 'Appendix'],
    ]);
    // The first candidate is the one used.
    expect(report.fields.find((field) => field.id === 'ini')?.rect.page).toBe(2);
    expect(anchorCandidatesOf(report)).toEqual([{ fieldId: 'ini', candidates: warning?.candidates }]);

    const chosen = (await validate(initials(2), pdf)).report;
    expect(chosen.warnings.map((issue) => issue.code)).not.toContain('anchor-ambiguous');
    expect(chosen.fields.find((field) => field.id === 'ini')?.rect.page).toBe(3);
    expect(anchorCandidatesOf(chosen)).toEqual([]);
  });

  it('reports a hash mismatch with the hash to use', async () => {
    const pdf = await fixturePdf();
    const request = await requestFor(pdf, structuredClone(DEFAULT_FIELDS));
    request.document.sha256 = '0'.repeat(64);
    const { report } = await validateRequestAgainstPdf(pdf, request);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ code: 'hash-mismatch', path: 'document.sha256' });
    expect(report.errors[0]?.hint).toContain(await sha256Hex(pdf));
  });

  it('reports schema errors with their path and field', async () => {
    const pdf = await fixturePdf();
    const { report } = await validateRequestAgainstPdf(pdf, {
      version: 1,
      document: { name: 'fixture.pdf', sha256: await sha256Hex(pdf) },
      fields: [
        { id: 'sig', type: 'signature', assignee: 'human', value: 'Ada Example', placement: rect(1, 10, 10, 50, 20) },
        { id: 'name', type: 'text', assignee: 'agent', placement: rect(1, 10, 40, -5, 20) },
      ],
    });
    expect(report.fields).toEqual([]);
    expect(report.errors.every((issue) => issue.code === 'invalid-request')).toBe(true);
    // A signature field cannot carry a value: the schema rejects it.
    expect(report.errors.some((issue) => issue.fieldId === 'sig')).toBe(true);
    expect(report.errors.some((issue) => issue.path === 'fields.1.placement.width' && issue.fieldId === 'name')).toBe(true);
    expect(report.errors.some((issue) => issue.path === 'fields.1.value')).toBe(true);
  });

  it('warns about overlapping fields, a missing signature field and an unchecked required checkbox', async () => {
    const { report } = await validate([
      { id: 'one', type: 'text', assignee: 'human', placement: rect(1, 72, 300, 200, 20) },
      { id: 'two', type: 'text', assignee: 'human', placement: rect(1, 100, 310, 200, 20) },
      { id: 'agree', type: 'checkbox', assignee: 'agent', value: false, placement: rect(1, 72, 400, 12, 12) },
    ]);
    expect(report.ok).toBe(true);
    expect(report.warnings.map((issue) => issue.code).sort()).toEqual(['fields-overlap', 'no-signing-field', 'required-checkbox-unchecked']);
    expect(report.warnings.find((issue) => issue.code === 'required-checkbox-unchecked')?.fieldId).toBe('agree');
  });

  it('reports agent values that cannot be drawn, with a hint', async () => {
    const { report } = await validate([
      ...DEFAULT_FIELDS,
      { id: 'long', type: 'text', assignee: 'agent', value: 'A very long value that cannot fit. '.repeat(20), placement: rect(1, 72, 340, 30, 8) },
      { id: 'cjk', type: 'text', assignee: 'agent', value: '甲乙', placement: rect(1, 72, 380, 200, 20) },
    ]);
    const byField = Object.fromEntries(report.errors.map((issue) => [issue.fieldId, issue]));
    expect(byField['long']).toMatchObject({ code: 'value-does-not-fit' });
    expect(byField['long']?.hint).toContain('Shorten the text');
    expect(byField['cjk']).toMatchObject({ code: 'unsupported-characters' });
    expect(byField['cjk']?.hint).toContain('assign the field to the human');
    expect(report.fields.map((field) => field.id)).toEqual(['sig', 'name']);
  });

  it('throws only for an unreadable PDF', async () => {
    await expect(validateRequestAgainstPdf(new Uint8Array([1, 2, 3]), {})).rejects.toMatchObject({ code: 'invalid-pdf' });
  });
});

describe('label-is-page-text', () => {
  it('warns when a label repeats the printed fragment next to its field, and not for a plain label', async () => {
    const pdf = new Uint8Array(await readFile(new URL('../../web/public/sample-nda.pdf', import.meta.url)));
    const field = (label: string): FieldInput => ({
      id: 'party_a',
      type: 'text',
      label,
      assignee: 'human',
      placement: { kind: 'acroField', name: 'hereinafter known as' },
    });
    const echoed = await validateRequestAgainstPdf(pdf, await requestFor(pdf, [field('hereinafter known as')]));
    expect(echoed.report.ok).toBe(true);
    expect(echoed.report.warnings.filter((issue) => issue.code === 'label-is-page-text')).toEqual([
      expect.objectContaining({ fieldId: 'party_a' }),
    ]);
    const plain = await validateRequestAgainstPdf(pdf, await requestFor(pdf, [field('Party A')]));
    expect(plain.report.warnings.filter((issue) => issue.code === 'label-is-page-text')).toEqual([]);
  });
});

describe('nearestTextMatches', () => {
  it('ranks a line that contains the needle first, with score 1, and ignores unrelated text', async () => {
    const { text } = await inspectPdf(await fixturePdf());
    const matches = nearestTextMatches(text, 'signature');
    expect(matches[0]).toMatchObject({ text: 'Signature: Date:', score: 1, page: 1 });
    expect(nearestTextMatches(text, 'zzzz')).toEqual([]);
    expect(nearestTextMatches(text, 'signature', 2)).toEqual([]);
  });
});
