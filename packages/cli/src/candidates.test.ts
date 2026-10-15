import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateRequestAgainstPdf } from '@sign-pdf/core';
import type { FieldInput } from '@sign-pdf/spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixturePdf, requestFor, runCli, workspace, type Workspace } from './test-helpers.ts';

const SAMPLE_PDF = fileURLToPath(new URL('../../web/public/sample-nda.pdf', import.meta.url));

interface CandidatesOut {
  ok: boolean;
  sha256: string;
  pageCount: number;
  truncated: boolean;
  total: number;
  candidates: Array<{
    number: number;
    kind: string;
    text: string;
    page: number;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    group?: string;
    suggested: { type?: FieldInput['type']; placement: FieldInput['placement'] };
  }>;
}

let ws: Workspace;
let pdfPath: string;

beforeEach(async () => {
  ws = await workspace();
  pdfPath = await ws.write('fixture.pdf', await fixturePdf());
});

afterEach(async () => {
  await ws.cleanup();
});

describe('sign-pdf candidates', () => {
  it('prints numbered candidates with a suggested type and a placement on one line of JSON', async () => {
    const result = await runCli(['candidates', pdfPath]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const json = (await runCli(['candidates', pdfPath, '--json'])).json<CandidatesOut>();
    expect(json).toMatchObject({ ok: true, pageCount: 1, truncated: false, total: 3 });
    expect(json.candidates.map((candidate) => [candidate.number, candidate.kind, candidate.text, candidate.suggested.type])).toEqual([
      [1, 'widget', 'full_name', 'text'],
      [2, 'label', 'Signature:', 'signature'],
      [3, 'label', 'Date:', 'date'],
    ]);
    expect(
      json.candidates.every(
        ({ confidence, reason, group }) =>
          ['high', 'medium', 'low'].includes(confidence) && reason.trim().length > 0 && (group === undefined || group.trim().length > 0),
      ),
    ).toBe(true);
    expect(result.stdout).toContain('C2  label  page 1');
    expect(result.stdout).toContain('"Signature:"');
    expect(result.stdout).toContain('3 candidate(s).');
    // The placement in the text output is the same JSON as in --json.
    const printed = [...result.stdout.matchAll(/placement: (.+)$/gm)].map((match) => JSON.parse(match[1] ?? '') as unknown);
    expect(printed).toEqual(json.candidates.map((candidate) => candidate.suggested.placement));
  });

  it('stops at --max and says that it did', async () => {
    const text = await runCli(['candidates', pdfPath, '--max', '1']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('C1  widget');
    expect(text.stdout).not.toContain('C2');
    expect(text.stdout).toContain('Truncated: showing the first 1 of 3 candidates. Use --max to see more.');
    const json = (await runCli(['candidates', pdfPath, '--max', '2', '--json'])).json<CandidatesOut>();
    expect(json).toMatchObject({ truncated: true, total: 3 });
    expect(json.candidates).toHaveLength(2);
  });

  it('refuses a --max that is not a whole number of at least 1', async () => {
    for (const max of ['0', '-1', '1.5', 'x', '']) {
      const result = await runCli(['candidates', pdfPath, '--max', max, '--json']);
      expect(result.code, max).toBe(1);
      expect(result.json<{ ok: boolean; error: { code: string } }>()).toMatchObject({ ok: false, error: { code: 'usage' } });
    }
    const missing = await runCli(['candidates']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('error [usage]');
  });

  it('gives placements that a request takes as they are: every candidate on the sample NDA validates', async () => {
    const result = await runCli(['candidates', SAMPLE_PDF, '--json']);
    expect(result.code).toBe(0);
    const { candidates, truncated } = result.json<CandidatesOut>();
    expect(truncated).toBe(false);
    expect(candidates.length).toBeGreaterThan(0);
    const pdf = new Uint8Array(await readFile(SAMPLE_PDF));
    const fields: FieldInput[] = candidates.map((candidate) => ({
      id: `c${candidate.number}`,
      type: candidate.suggested.type ?? 'text',
      assignee: 'human',
      placement: candidate.suggested.placement,
    }));
    const { report } = await validateRequestAgainstPdf(pdf, await requestFor(pdf, fields));
    expect(report.errors).toEqual([]);
    expect(report.fields.map((field) => field.id)).toEqual(fields.map((field) => field.id));
  });
});

describe('sign-pdf draft', () => {
  it('writes a deterministic request from selected candidates and returns resolved fields as JSON', async () => {
    const outputPath = ws.path('draft.request.json');
    const result = await runCli([
      'draft',
      pdfPath,
      '-o',
      outputPath,
      '--candidates',
      '1,3',
      '--set',
      '1=Ada Example',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const data = result.json<{
      ok: boolean;
      request: { fields: Array<{ id: string; assignee: string; value?: string }> };
      fields: Array<{ candidateNumber: number; id: string; rect: { page: number } }>;
      skipped: Array<{ number: number; reason: string }>;
      path: string;
    }>();
    expect(data).toMatchObject({ ok: true, path: outputPath });
    expect(data.request.fields).toEqual([
      expect.objectContaining({ id: 'full_name', assignee: 'agent', value: 'Ada Example' }),
      expect.objectContaining({ id: 'date', assignee: 'human' }),
    ]);
    expect(data.fields.map(({ candidateNumber, id }) => [candidateNumber, id])).toEqual([[1, 'full_name'], [3, 'date']]);
    expect(data.skipped).toEqual([{ number: 2, reason: 'not_selected' }]);
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(data.request);

    const validated = await runCli(['validate', pdfPath, outputPath, '--json']);
    expect(validated.code).toBe(0);
    expect(validated.json<{ errors: unknown[] }>().errors).toEqual([]);
  });

  it('prints the request for a person and gives actionable errors for invalid selections or signature values', async () => {
    const person = await runCli(['draft', pdfPath]);
    expect(person.code).toBe(0);
    expect(person.stdout).toContain('Drafted 3 field(s) from 3 candidate(s).');
    expect(person.stdout).toContain('"version": 1');

    for (const args of [
      ['--candidates', ''],
      ['--candidates', '999'],
      ['--candidates', '2', '--set', '2=not a signature'],
    ]) {
      const failure = await runCli(['draft', pdfPath, ...args, '--json']);
      expect(failure.code).toBe(1);
      expect(failure.json<{ ok: boolean; error: { code: string; hint: string } }>()).toMatchObject({
        ok: false,
        error: { code: 'invalid-argument', hint: expect.any(String) },
      });
    }
  });
});
