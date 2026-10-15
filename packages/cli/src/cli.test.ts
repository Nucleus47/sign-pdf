import { readFile, readdir } from 'node:fs/promises';
import { decodePacket, sha256Hex } from '@sign-pdf/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FieldInput } from '@sign-pdf/spec';
import type { ValidationReport } from '@sign-pdf/core';
import { MAX_BAD_NONCES } from './session.ts';
import {
  DEFAULT_FIELDS,
  fixturePdf,
  http,
  imageOnlyPdf,
  rect,
  requestFor,
  runCli,
  signAsHuman,
  workspace,
  type CliResult,
  type Workspace,
} from './test-helpers.ts';
import { createPacket, encodePacket } from '@sign-pdf/core';

let ws: Workspace;
let pdf: Uint8Array;
let pdfPath: string;

beforeEach(async () => {
  ws = await workspace();
  pdf = await fixturePdf();
  pdfPath = await ws.write('fixture.pdf', pdf);
});

afterEach(async () => {
  await ws.cleanup();
});

async function requestFile(fields = DEFAULT_FIELDS, name = 'request.json'): Promise<string> {
  return ws.write(name, JSON.stringify(await requestFor(pdf, fields)));
}

function expectNoStackTrace(stderr: string): void {
  expect(stderr).not.toMatch(/\n\s+at .+:\d+:\d+/);
}

interface JsonFailure {
  ok: boolean;
  error: { code: string; message: string; fieldId?: string; hint?: string; errors?: Array<{ code: string }> };
  [key: string]: unknown;
}

/**
 * The --json failure contract: stdout is exactly one JSON object that leads
 * with `ok: false` and an `error`, stderr is one short line, and the exit code
 * is the documented one.
 */
function expectJsonFailure(result: CliResult, code: string, exit = 1): JsonFailure {
  expect(result.code).toBe(exit);
  // JSON.parse accepts one value only: anything else on stdout would make it throw.
  const out = result.json<JsonFailure>();
  expect(Object.keys(out).slice(0, 2)).toEqual(['ok', 'error']);
  expect(out.ok).toBe(false);
  expect(out.error.code).toBe(code);
  expect(out.error.message).not.toBe('');
  expect(result.stderr).toBe(`error [${code}]: ${out.error.message}\n`);
  expect(out.error.message).not.toContain('\n');
  expect(result.stderr.length).toBeLessThan(600);
  expectNoStackTrace(result.stderr);
  return out;
}

/** The text-mode failure: nothing that parses as JSON on stdout, the error on stderr. */
function expectTextFailure(result: CliResult, code: string): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(new RegExp(`^error \\[${code}\\]: `));
}

describe('general', () => {
  it('prints help and the version', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('sign-pdf <command>');
    expect((await runCli(['--version'])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('fails with a usage error on an unknown command, option or argument count', async () => {
    for (const args of [['frobnicate'], ['inspect'], ['inspect', pdfPath, '--bogus'], ['schema', 'extra']]) {
      const out = expectJsonFailure(await runCli([...args, '--json']), 'usage');
      expect(Object.keys(out)).toEqual(['ok', 'error']);
      expectTextFailure(await runCli(args), 'usage');
    }
  });

  it('has no option that takes a signature', async () => {
    const help = (await runCli(['--help'])).stdout;
    expect(help).not.toMatch(/--sign(ature)?\b|--typed|--initials/);
    const result = await runCli(['request', pdfPath, await requestFile(), '--signature', 'x.png']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[usage]');
  });
});

describe('inspect', () => {
  it('reports pages, form fields and text as JSON', async () => {
    const result = await runCli(['inspect', pdfPath, '--json']);
    expect(result.code).toBe(0);
    const out = result.json<{
      sha256: string;
      pageCount: number;
      pages: Array<{ page: number; width: number; height: number }>;
      acroFields: Array<{ name: string; type: string }>;
      text: Array<{ text: string; page: number; x: number; y: number }>;
    }>();
    expect(out.sha256).toBe(await sha256Hex(pdf));
    expect(out.pages.map(({ page, width, height }) => ({ page, width, height }))).toEqual([{ page: 1, width: 612, height: 792 }]);
    expect(out.acroFields).toMatchObject([{ name: 'full_name', type: 'text' }]);
    const label = out.text.find((run) => run.text === 'Signature:');
    expect(label).toMatchObject({ page: 1 });
    expect(label?.x).toBeCloseTo(72, 0);
    // Baseline 580 points from the top; the run's box sits just above it.
    expect(label?.y).toBeGreaterThan(560);
    expect(label?.y).toBeLessThan(580);
  });

  it('prints readable text by default', async () => {
    const result = await runCli(['inspect', pdfPath]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Pages: 1');
    expect(result.stdout).toContain('"full_name"  text');
    expect(result.stdout).toContain('"Signature:"');
  });

  it('supports a lean summary and the image-only preview-to-rect fallback', async () => {
    const imageBytes = await imageOnlyPdf();
    const imagePdf = await ws.write('image-only.pdf', imageBytes);

    const full = await runCli(['inspect', imagePdf, '--json']);
    expect(full.stdout).toBe(
      `${JSON.stringify(
        {
          ok: true,
          sha256: await sha256Hex(imageBytes),
          pageCount: 1,
          pages: [{ page: 1, width: 612, height: 792 }],
          acroFields: [],
          text: [],
        },
        null,
        2,
      )}\n`,
    );

    const diagnosis = (await runCli(['inspect', imagePdf, '--summary', '--json'])).json<{
      pages: Array<{ page: number; imageOnly: boolean; hasText: boolean }>;
      imageOnlyPages: number[];
      warnings: Array<{ code: string; hint: string }>;
    }>();
    expect(diagnosis.pages).toEqual([expect.objectContaining({ page: 1, imageOnly: true, hasText: false })]);
    expect(diagnosis.imageOnlyPages).toEqual([1]);
    expect(diagnosis.warnings[0]).toMatchObject({ code: 'image-only-page', hint: expect.stringContaining('explicit rect placements') });

    const candidates = (await runCli(['candidates', imagePdf, '--json'])).json<{
      candidates: unknown[];
      warnings: Array<{ code: string; hint: string }>;
    }>();
    expect(candidates.candidates).toEqual([]);
    expect(candidates.warnings[0]).toMatchObject({ code: 'image-only-page', hint: expect.stringContaining('render_preview on the bare page') });

    // The bare-page preview exposes page 1 and the rulers; place by an explicit rect, then validate it.
    const preview = await runCli(['preview', imagePdf, '--candidates', '--pages', '1', '--out', ws.path('preview'), '--json']);
    expect(preview.code).toBe(0);
    expect(preview.json<{ images: Array<{ page: number }> }>().images.map(({ page: number }) => number)).toEqual([1]);
    const request = await requestFor(imageBytes, [
      { id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 72, 100, 180, 30) },
    ]);
    const validated = await runCli(['validate', imagePdf, await ws.write('image-request.json', JSON.stringify(request)), '--json']);
    expect(validated.code, validated.stdout).toBe(0);
    expect(validated.json<ValidationReport>()).toMatchObject({ ok: true, errors: [], fields: [{ id: 'sig', rect: { page: 1, x: 72, y: 100 } }] });
  });

  it('skips text with --no-text and filters with --page', async () => {
    const twoPages = await ws.write('two.pdf', await fixturePdf({ pages: 2 }));
    const noText = (await runCli(['inspect', twoPages, '--no-text', '--json'])).json<{ text: unknown[] }>();
    expect(noText.text).toEqual([]);

    const second = (await runCli(['inspect', twoPages, '--page', '2', '--json'])).json<{
      pageCount: number;
      pages: Array<{ page: number }>;
      acroFields: unknown[];
      text: Array<{ text: string; page: number }>;
    }>();
    expect(second.pageCount).toBe(2);
    expect(second.pages.map((page) => page.page)).toEqual([2]);
    expect(second.acroFields).toEqual([]);
    expect(second.text.map((run) => run.text)).toEqual(['Appendix 1']);

    const beyond = await runCli(['inspect', twoPages, '--page', '3']);
    expect(beyond.code).toBe(1);
    expect(beyond.stderr).toContain('[usage]');
  });

  it('fails cleanly on a missing file and on a file that is not a PDF', async () => {
    const missing = await runCli(['inspect', ws.path('absent.pdf')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('error [file-not-found]');
    expectNoStackTrace(missing.stderr);

    const notPdf = await runCli(['inspect', await ws.write('notes.pdf', 'plain text'), '--json']);
    expectJsonFailure(notPdf, 'invalid-pdf');
  });
});

describe('schema', () => {
  it('prints the bare sign request JSON Schema, and with --json wraps it as { ok, schema }', async () => {
    const plain = await runCli(['schema']);
    expect(plain.code).toBe(0);
    const schema = plain.json<{ type: string; properties: Record<string, unknown> }>();
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['version', 'document', 'fields']));
    expect(schema).not.toHaveProperty('ok');

    const wrapped = await runCli(['schema', '--json']);
    expect(wrapped.code).toBe(0);
    expect(wrapped.json()).toEqual({ ok: true, schema });
    expect(wrapped.stderr).toBe('');
  });
});

describe('validate', () => {
  it('prints the resolved rectangle of every field', async () => {
    const result = await runCli(['validate', pdfPath, await requestFile(), '--json']);
    expect(result.code).toBe(0);
    const report = result.json<ValidationReport>();
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.fields.map((field) => field.id)).toEqual(['sig', 'name']);
    const sig = report.fields[0];
    expect(sig).toMatchObject({ type: 'signature', assignee: 'human', placement: 'anchor' });
    // Right of the "Signature:" label (which ends near x 127), centred on its line.
    expect(sig?.rect.x).toBeGreaterThan(125);
    expect(sig?.rect.x).toBeLessThan(140);
    expect(sig?.rect.y).toBeGreaterThan(545);
    expect((sig?.rect.y ?? 0) + (sig?.rect.height ?? 0)).toBeLessThan(600);
    expect(report.fields[1]?.rect).toEqual({ page: 1, x: 72, y: 300, width: 200, height: 20 });

    const text = await runCli(['validate', pdfPath, await requestFile()]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('ok    sig  signature (human)  page 1');
    expect(text.stdout).toContain('Valid: 2 field(s) resolved.');
  });

  it('reports every bad field with a hint, and still resolves the good ones', async () => {
    const file = await requestFile([
      ...DEFAULT_FIELDS,
      { id: 'when', type: 'date', assignee: 'human', placement: { kind: 'anchor', text: 'Signatures', width: 80, height: 16 } },
      { id: 'who', type: 'text', assignee: 'human', placement: { kind: 'acroField', name: 'fullname' } },
      { id: 'off', type: 'text', assignee: 'human', placement: rect(1, 500, 300, 200, 20) },
      { id: 'far', type: 'text', assignee: 'human', placement: rect(4, 10, 10, 50, 20) },
    ]);
    const result = await runCli(['validate', pdfPath, file, '--json']);
    expect(result.code).toBe(1);
    const report = result.json<ValidationReport>();
    expect(report.ok).toBe(false);
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

    const text = await runCli(['validate', pdfPath, file]);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('error [anchor-not-found] field "when"');
    expect(text.stdout).toContain('hint:');
    expect(text.stdout).toContain('Not valid: 4 error(s), 2 field(s) resolved.');
  });

  it('says how to fix an anchor whose occurrence is too high', async () => {
    const file = await requestFile([
      { id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'anchor', text: 'signature:', occurrence: 2, width: 80, height: 16 } },
    ]);
    const report = (await runCli(['validate', pdfPath, file, '--json'])).json<ValidationReport>();
    expect(report.errors[0]?.code).toBe('anchor-not-found');
    expect(report.errors[0]?.hint).toContain('occurrence');
  });

  it('warns about an anchor that matches more than one place and lists the candidates', async () => {
    pdf = await fixturePdf({ pages: 3 });
    pdfPath = await ws.write('appendix.pdf', pdf);
    const initials = (occurrence?: number): FieldInput[] => [
      ...DEFAULT_FIELDS,
      {
        id: 'ini',
        type: 'initials',
        assignee: 'human',
        placement: { kind: 'anchor', text: 'appendix', width: 40, height: 16, align: 'below', ...(occurrence ? { occurrence } : {}) },
      },
    ];
    const json = await runCli(['validate', pdfPath, await requestFile(initials()), '--json']);
    expect(json.code).toBe(0);
    const report = json.json<ValidationReport>();
    expect(report.ok).toBe(true);
    const warning = report.warnings.find((issue) => issue.code === 'anchor-ambiguous');
    expect(warning).toMatchObject({ fieldId: 'ini', hint: expect.stringContaining('occurrence') });
    expect(warning?.candidates?.map((candidate) => [candidate.page, candidate.text])).toEqual([
      [2, 'Appendix'],
      [3, 'Appendix'],
    ]);
    // The first candidate is the one used.
    expect(report.fields.find((field) => field.id === 'ini')?.rect.page).toBe(2);

    const text = await runCli(['validate', pdfPath, await requestFile(initials())]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('warning [anchor-ambiguous] field "ini"');
    expect(text.stdout).toMatch(/candidate 2 \(occurrence 2\): page 3 .*"Appendix"/);

    const chosen = (await runCli(['validate', pdfPath, await requestFile(initials(2)), '--json'])).json<ValidationReport>();
    expect(chosen.warnings.map((issue) => issue.code)).not.toContain('anchor-ambiguous');
    expect(chosen.fields.find((field) => field.id === 'ini')?.rect.page).toBe(3);
  });

  it('reports a hash mismatch with the hash to use', async () => {
    const request = await requestFor(pdf);
    request.document.sha256 = '0'.repeat(64);
    const result = await runCli(['validate', pdfPath, await ws.write('stale.json', JSON.stringify(request)), '--json']);
    expect(result.code).toBe(1);
    const report = result.json<ValidationReport>();
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ code: 'hash-mismatch', path: 'document.sha256' });
    expect(report.errors[0]?.hint).toContain(await sha256Hex(pdf));
  });

  it('reports schema errors with their path and field', async () => {
    const request = {
      version: 1,
      document: { name: 'fixture.pdf', sha256: await sha256Hex(pdf) },
      fields: [
        { id: 'sig', type: 'signature', assignee: 'human', value: 'Ada Example', placement: rect(1, 10, 10, 50, 20) },
        { id: 'name', type: 'text', assignee: 'agent', placement: rect(1, 10, 40, -5, 20) },
      ],
    };
    const result = await runCli(['validate', pdfPath, await ws.write('bad.json', JSON.stringify(request)), '--json']);
    expect(result.code).toBe(1);
    const report = result.json<ValidationReport>();
    expect(report.fields).toEqual([]);
    expect(report.errors.every((issue) => issue.code === 'invalid-request')).toBe(true);
    // A signature field cannot carry a value: the schema rejects it.
    expect(report.errors.some((issue) => issue.fieldId === 'sig')).toBe(true);
    expect(report.errors.some((issue) => issue.path === 'fields.1.placement.width' && issue.fieldId === 'name')).toBe(true);
    expect(report.errors.some((issue) => issue.path === 'fields.1.value')).toBe(true);
  });

  it('warns about overlapping fields, a missing signature field and an unchecked required checkbox', async () => {
    const file = await requestFile([
      { id: 'one', type: 'text', assignee: 'human', placement: rect(1, 72, 300, 200, 20) },
      { id: 'two', type: 'text', assignee: 'human', placement: rect(1, 100, 310, 200, 20) },
      { id: 'agree', type: 'checkbox', assignee: 'agent', value: false, placement: rect(1, 72, 400, 12, 12) },
    ]);
    const result = await runCli(['validate', pdfPath, file, '--json']);
    expect(result.code).toBe(0);
    const report = result.json<ValidationReport>();
    expect(report.ok).toBe(true);
    expect(report.warnings.map((issue) => issue.code).sort()).toEqual([
      'fields-overlap',
      'no-signing-field',
      'required-checkbox-unchecked',
    ]);
    expect(report.warnings.find((issue) => issue.code === 'required-checkbox-unchecked')?.fieldId).toBe('agree');
  });

  it('reports agent values that cannot be drawn, with a hint', async () => {
    const file = await requestFile([
      ...DEFAULT_FIELDS,
      { id: 'long', type: 'text', assignee: 'agent', value: 'A very long value that cannot fit. '.repeat(20), placement: rect(1, 72, 340, 30, 8) },
      { id: 'cjk', type: 'text', assignee: 'agent', value: '甲乙', placement: rect(1, 72, 380, 200, 20) },
    ]);
    const result = await runCli(['validate', pdfPath, file, '--json']);
    expect(result.code).toBe(1);
    const report = result.json<ValidationReport>();
    const byField = Object.fromEntries(report.errors.map((issue) => [issue.fieldId, issue]));
    expect(byField['long']).toMatchObject({ code: 'value-does-not-fit' });
    expect(byField['long']?.hint).toContain('Shorten the text');
    expect(byField['cjk']).toMatchObject({ code: 'unsupported-characters' });
    expect(byField['cjk']?.hint).toContain('assign the field to the human');
    expect(report.fields.map((field) => field.id)).toEqual(['sig', 'name']);
  });

  it('fails cleanly when the request file is missing or is not JSON', async () => {
    const missing = await runCli(['validate', pdfPath, ws.path('absent.json')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('error [file-not-found]');

    const broken = await runCli(['validate', pdfPath, await ws.write('broken.json', '{ "version": 1,')]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('error [invalid-json]');
    expectNoStackTrace(broken.stderr);
  });
});

describe('packet', () => {
  it('writes a packet that decodes to the same PDF and request', async () => {
    const out = ws.path('out.signpacket.json');
    const result = await runCli(['packet', pdfPath, await requestFile(), '-o', out, '--json']);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ ok: true, path: out, fieldCount: 2, documentSha256: await sha256Hex(pdf) });
    const decoded = await decodePacket(await readFile(out, 'utf8'));
    expect(decoded.pdf).toEqual(pdf);
    expect(decoded.packet.request.fields.map((field) => field.id)).toEqual(['sig', 'name']);
  });

  it('defaults to <name>.signpacket.json next to the PDF and never overwrites without --force', async () => {
    const request = await requestFile();
    const first = await runCli(['packet', pdfPath, request]);
    expect(first.code).toBe(0);
    const expected = ws.path('fixture.signpacket.json');
    expect(first.stdout).toContain(expected);
    const before = await readFile(expected, 'utf8');

    const second = await runCli(['packet', pdfPath, request]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('error [file-exists]');
    expect(await readFile(expected, 'utf8')).toBe(before);

    expect((await runCli(['packet', pdfPath, request, '--force'])).code).toBe(0);
  });

  it('refuses a request that does not resolve', async () => {
    const file = await requestFile([
      { id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'anchor', text: 'Initial here', width: 80, height: 16 } },
    ]);
    const out = ws.path('never.signpacket.json');
    const result = await runCli(['packet', pdfPath, file, '-o', out, '--json']);
    expect(result.code).toBe(1);
    const error = expectJsonFailure(result, 'anchor-not-found');
    expect(error.error).toMatchObject({ code: 'anchor-not-found', fieldId: 'sig' });
    expect(error.error.errors).toHaveLength(1);
    await expect(readFile(out)).rejects.toThrow();
  });
});

describe('request', () => {
  it('ends at once as cancelled when wrong nonces lock the signing link', async () => {
    let guessing: Promise<unknown> = Promise.resolve();
    const result = await runCli(['request', pdfPath, await requestFile(), '--web-dir', await ws.webDir(), '--timeout', '600', '--json'], {
      openBrowser: (link) => {
        const port = Number(new URL(link).port);
        guessing = (async () => {
          for (let attempt = 1; attempt <= MAX_BAD_NONCES; attempt++) {
            await http(port, {
              method: 'POST',
              path: '/api/session',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ nonce: `wrong-${attempt}` }),
            });
          }
        })();
      },
    });
    await guessing;
    // The command returns well before the 600-second timeout (the test itself would time out first).
    expect(result.code).toBe(1);
    const out = result.json<JsonFailure>();
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('cancelled');
    expect(out.error.message).toContain('locked');
    expect(out.error.hint).toContain('again');
    expect(out['reason']).toBe('locked');
    expect(result.stderr).toContain('error [cancelled]: Cancelled: too many wrong attempts');
  });
});

describe('verify', () => {
  it('reads the audit record of a signed PDF and calls it unverified', async () => {
    const signed = await signAsHuman(encodePacket(await createPacket(pdf, await requestFor(pdf))));
    const signedPath = await ws.write('signed.pdf', signed.pdf);

    const result = await runCli(['verify', signedPath, '--json']);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({
      hasAuditRecord: true,
      integrity: 'unverified',
      sha256: signed.sha256,
      audit: { signer: { name: 'Ada Example' }, document: { originalSha256: await sha256Hex(pdf) } },
    });
    expect(result.json<{ auditNotice: string }>().auditNotice).toContain('unauthenticated');

    const text = await runCli(['verify', signedPath]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Integrity: unverified');
    expect(text.stdout).toContain('"Ada Example"');
    // The record is a claim, not proof: the output must not suggest otherwise.
    expect(text.stdout.replaceAll('unverified', '')).not.toMatch(/\bvalid\b|verified/i);
  });

  it('lists every signer of a document with several signers', async () => {
    const request = await requestFor(
      pdf,
      [
        { id: 'sigA', type: 'signature', assignee: 'human', signerId: 'a', placement: rect(1, 72, 500, 180, 36) },
        { id: 'sigB', type: 'signature', assignee: 'human', signerId: 'b', placement: rect(1, 300, 500, 180, 36) },
      ],
      { signers: [{ id: 'a' }, { id: 'b' }] },
    );
    const signed = await signAsHuman(encodePacket(await createPacket(pdf, request)));
    const text = await runCli(['verify', await ws.write('signed.pdf', signed.pdf)]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('signer 1 of 2 (a), name as typed: "Signer 1"');
    expect(text.stdout).toContain('signer 2 of 2 (b), name as typed: "Signer 2"');
    expect(text.stdout).not.toContain('problem');
  });

  it('exits 1 with the code not-signed for a PDF without an audit record', async () => {
    const result = await runCli(['verify', pdfPath, '--json']);
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ hasAuditRecord: false, integrity: 'unverified' });
    expectJsonFailure(result, 'not-signed');
  });
});

describe('--json contract', () => {
  it('a success is one object that leads with ok: true, for every command', async () => {
    const request = await requestFile();
    const signedPath = await ws.write('signed.pdf', (await signAsHuman(encodePacket(await createPacket(pdf, await requestFor(pdf))))).pdf);
    const runs: Array<[string[], string[]]> = [
      [['inspect', pdfPath], ['ok', 'sha256', 'pageCount', 'pages', 'acroFields', 'text']],
      [['schema'], ['ok', 'schema']],
      [['validate', pdfPath, request], ['ok', 'sha256', 'pages', 'fields', 'errors', 'warnings']],
      [['preview', pdfPath, request, '--out', ws.path('preview')], ['ok', 'outDir', 'coordinates', 'images', 'fields', 'warnings']],
      [['packet', pdfPath, request], ['ok', 'path', 'bytes', 'documentSha256', 'fieldCount']],
      [['verify', signedPath], ['ok', 'hasAuditRecord', 'integrity', 'sha256', 'problems', 'audit', 'auditNotice']],
    ];
    for (const [args, keys] of runs) {
      const result = await runCli([...args, '--json']);
      expect(result.code, args[0]).toBe(0);
      const out = result.json();
      expect(out['ok'], args[0]).toBe(true);
      expect(Object.keys(out)[0], args[0]).toBe('ok');
      expect(Object.keys(out).sort(), args[0]).toEqual([...keys].sort());
      expect(out, args[0]).not.toHaveProperty('error');
      expect(result.stderr, args[0]).toBe('');
    }
  });

  it('a usage error is { ok: false, error } on stdout and one line on stderr', async () => {
    for (const args of [['inspect'], ['validate', pdfPath], ['preview', pdfPath, 'r.json'], ['packet'], ['request', pdfPath], ['verify', pdfPath, 'extra'], ['inspect', pdfPath, '--page', 'two']]) {
      const out = expectJsonFailure(await runCli([...args, '--json']), 'usage');
      expect(Object.keys(out), args.join(' ')).toEqual(['ok', 'error']);
    }
  });

  it('a missing or unreadable file is reported the same way by every command that reads one', async () => {
    const request = await requestFile();
    const absent = ws.path('absent.pdf');
    for (const args of [
      ['inspect', absent],
      ['validate', absent, request],
      ['validate', pdfPath, ws.path('absent.json')],
      ['preview', absent, request, '--out', ws.path('preview')],
      ['packet', absent, request],
      ['request', absent, request],
      ['request', pdfPath, ws.path('absent.json')],
      ['verify', absent],
    ]) {
      const out = expectJsonFailure(await runCli([...args, '--json']), 'file-not-found');
      expect(Object.keys(out), args.join(' ')).toEqual(['ok', 'error']);
    }
    expectJsonFailure(await runCli(['validate', pdfPath, await ws.write('broken.json', '{ "version": 1,'), '--json']), 'invalid-json');
    expectJsonFailure(await runCli(['verify', await ws.write('notes.pdf', 'plain text'), '--json']), 'invalid-pdf');
    expectJsonFailure(await runCli(['inspect', ws.dir, '--json']), 'file-unreadable');
    // Nothing was written by the commands that failed.
    expect((await readdir(ws.dir)).sort()).toEqual(['broken.json', 'fixture.pdf', 'notes.pdf', 'request.json']);
  });

  it('validate reports an invalid request as { ok: false, error, ...report }', async () => {
    const file = await requestFile([
      ...DEFAULT_FIELDS,
      { id: 'off', type: 'text', assignee: 'human', placement: rect(1, 500, 300, 200, 20) },
      { id: 'far', type: 'text', assignee: 'human', placement: rect(4, 10, 10, 50, 20) },
    ]);
    const out = expectJsonFailure(await runCli(['validate', pdfPath, file, '--json']), 'field-out-of-bounds');
    expect(Object.keys(out).sort()).toEqual(['error', 'errors', 'fields', 'ok', 'pages', 'sha256', 'warnings']);
    expect(out.error.fieldId).toBe('off');
    expect(out['sha256']).toBe(await sha256Hex(pdf));
    expect((out['pages'] as Array<{ page: number; width: number; height: number }>).map(({ page, width, height }) => ({ page, width, height }))).toEqual([
      { page: 1, width: 612, height: 792 },
    ]);
    const report = out as unknown as ValidationReport;
    expect(report.errors.map((issue) => [issue.fieldId, issue.code])).toEqual([
      ['off', 'field-out-of-bounds'],
      ['far', 'page-out-of-range'],
    ]);
    expect(report.fields.map((field) => field.id)).toEqual(['sig', 'name']);
  });

  it('preview and packet report an invalid request as { ok: false, error } with every issue', async () => {
    const file = await requestFile([
      { id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'anchor', text: 'Initial here', width: 80, height: 16 } },
      { id: 'far', type: 'text', assignee: 'human', placement: rect(4, 10, 10, 50, 20) },
    ]);
    for (const args of [
      ['preview', pdfPath, file, '--out', ws.path('preview')],
      ['packet', pdfPath, file, '-o', ws.path('never.signpacket.json')],
    ]) {
      const out = expectJsonFailure(await runCli([...args, '--json']), 'anchor-not-found');
      expect(Object.keys(out)).toEqual(['ok', 'error']);
      expect(out.error.fieldId).toBe('sig');
      expect(out.error.errors?.map((issue) => issue.code)).toEqual(['anchor-not-found', 'page-out-of-range']);
    }
    expect((await readdir(ws.dir)).sort()).toEqual(['fixture.pdf', 'request.json']);
  });

  it('verify of an unsigned PDF is { ok: false, error: not-signed } with what was read', async () => {
    const out = expectJsonFailure(await runCli(['verify', pdfPath, '--json']), 'not-signed');
    expect(out).toMatchObject({ hasAuditRecord: false, integrity: 'unverified', sha256: await sha256Hex(pdf) });
    expect(out).not.toHaveProperty('audit');
  });

  it('a refused output path is reported the same way', async () => {
    const request = await requestFile();
    expect((await runCli(['packet', pdfPath, request])).code).toBe(0);
    const out = expectJsonFailure(await runCli(['packet', pdfPath, request, '--json']), 'file-exists');
    expect(out.error.hint).toContain('--force');
    expectJsonFailure(await runCli(['packet', pdfPath, request, '-o', pdfPath, '--json']), 'output-is-input');
    expectJsonFailure(await runCli(['request', pdfPath, request, '-o', request, '--force', '--json']), 'output-is-input');
  });
});

describe('argument parsing', () => {
  it('accepts --help, -h, help and --version in first position only', async () => {
    for (const args of [['--help'], ['-h'], ['help'], ['--help', '--json'], ['-h', 'inspect']]) {
      const result = await runCli(args);
      expect(result.code, args.join(' ')).toBe(0);
      expect(result.stdout).toContain('Usage: sign-pdf <command> [options]');
      expect(result.stderr).toBe('');
    }
    const version = await runCli(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);

    // After a command, --version is not an option and `help` is one argument too many.
    for (const args of [['inspect', '--version'], ['inspect', pdfPath, '--version'], ['schema', '--version'], ['inspect', pdfPath, 'help'], ['schema', 'help']]) {
      const result = await runCli(args);
      expectTextFailure(result, 'usage');
      expect(result.stdout).not.toMatch(/\d+\.\d+\.\d+/);
    }
    // --help is a real option of every command.
    for (const args of [['inspect', pdfPath, '--help'], ['schema', '-h'], ['request', '--help'], ['inspect', '--bogus', '--help']]) {
      const result = await runCli(args);
      expect(result.code, args.join(' ')).toBe(0);
      expect(result.stdout).toContain('Usage: sign-pdf <command> [options]');
    }
    // No arguments at all: the help, as an error.
    const none = await runCli([]);
    expect(none.code).toBe(1);
    expect(none.stdout).toContain('Usage: sign-pdf <command> [options]');
  });

  it('refuses an option before the command', async () => {
    const request = await requestFile();
    for (const args of [
      ['--json', 'inspect', pdfPath],
      ['--force', 'packet', pdfPath, request],
      ['--no-text', 'inspect', pdfPath],
      ['-o', ws.path('x.signpacket.json'), 'packet', pdfPath, request],
      ['--page', '1', 'inspect', pdfPath],
      ['--bogus'],
      ['--', 'inspect', pdfPath],
      ['-v'],
    ]) {
      const result = await runCli(args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toMatch(/^error \[usage\]: The command must come first/);
      expect(result.stdout).not.toContain('SHA-256');
    }
    // --json is still honoured for the error report when it is a real flag.
    const out = expectJsonFailure(await runCli(['--json', 'inspect', pdfPath]), 'usage');
    expect(out.error.message).toContain('The command must come first');
    expect((await readdir(ws.dir)).sort()).toEqual(['fixture.pdf', 'request.json']);
  });

  it('refuses unknown commands and unknown options', async () => {
    const request = await requestFile();
    for (const args of [
      ['frobnicate'],
      ['frobnicate', '--help'],
      ['sign', pdfPath],
      ['constructor'],
      ['toString'],
      ['Inspect', pdfPath],
    ]) {
      const result = await runCli(args);
      expectTextFailure(result, 'usage');
      expect(result.stderr, args.join(' ')).toContain('Unknown command');
    }
    for (const args of [
      ['inspect', pdfPath, '--bogus'],
      ['inspect', pdfPath, '-x'],
      ['inspect', pdfPath, '--out', ws.path('x')],
      ['inspect', pdfPath, '--json=yes'],
      ['inspect', pdfPath, '--page'],
      ['validate', pdfPath, request, '--pages', '1'],
      ['verify', pdfPath, '--no-open'],
      ['schema', '--timeout', '5'],
      ['packet', pdfPath, request, '--web-dir', ws.dir],
    ]) {
      expectTextFailure(await runCli(args), 'usage');
    }
    expect((await readdir(ws.dir)).sort()).toEqual(['fixture.pdf', 'request.json']);
  });

  it('refuses --force on the commands that do not write a file to replace', async () => {
    const request = await requestFile();
    for (const args of [
      ['inspect', pdfPath],
      ['schema'],
      ['validate', pdfPath, request],
      ['preview', pdfPath, request, '--out', ws.path('preview')],
      ['verify', pdfPath],
    ]) {
      expectTextFailure(await runCli([...args, '--force']), 'usage');
      expectJsonFailure(await runCli([...args, '--force', '--json']), 'usage');
    }
    // It is an option of packet (and of request).
    expect((await runCli(['packet', pdfPath, request, '--force'])).code).toBe(0);
    expect((await runCli(['packet', pdfPath, request, '--force'])).code).toBe(0);
    expect((await readdir(ws.dir)).sort()).toEqual(['fixture.pdf', 'fixture.signpacket.json', 'request.json']);
  });

  it('reads --json=true and --json=1 as --json, and --json=false and --json=0 as --no-json', async () => {
    for (const value of ['1', 'true', 'TRUE']) {
      const result = await runCli(['inspect', pdfPath, `--json=${value}`]);
      expect(result.code, value).toBe(0);
      expect(result.json<{ ok: boolean }>().ok, value).toBe(true);
      // A failure is JSON too.
      expectJsonFailure(await runCli(['inspect', ws.path('absent.pdf'), `--json=${value}`]), 'file-not-found');
    }
    for (const value of ['0', 'false', 'False']) {
      const result = await runCli(['inspect', pdfPath, '--json', `--json=${value}`]);
      expect(result.code, value).toBe(0);
      expect(() => result.json(), value).toThrow();
      expectTextFailure(await runCli(['inspect', ws.path('absent.pdf'), `--json=${value}`]), 'file-not-found');
    }
    // Any other value is a usage error; the value of another option is never read as --json.
    expectTextFailure(await runCli(['inspect', pdfPath, '--json=yes']), 'usage');
    expectTextFailure(await runCli(['packet', pdfPath, await requestFile(), '-o', '--json=1']), 'usage');
  });

  it("does not read --json or --help out of another option's value", async () => {
    const request = await requestFile();
    const absent = ws.path('absent.pdf');
    // `--out --json`: the parser refuses the ambiguous value; the report is text, not JSON.
    for (const command of ['packet', 'request', 'preview']) {
      expectTextFailure(await runCli([command, pdfPath, request, '--out', '--json']), 'usage');
      expectTextFailure(await runCli([command, pdfPath, request, '-o', '--json']), 'usage');
      const help = await runCli([command, pdfPath, request, '--out', '--help']);
      expectTextFailure(help, 'usage');
      expect(help.stdout).not.toContain('Usage:');
    }
    // `-o=--json` and `--out=--json` are values. The command then fails on the missing PDF, in text mode.
    for (const value of ['-o=--json', '--out=--json', '-o=--help', '--out=--help', '-o--json']) {
      const result = await runCli(['packet', absent, request, value]);
      expectTextFailure(result, 'file-not-found');
      expect(result.stdout).not.toContain('Usage:');
    }
    for (const args of [['--timeout', '--json'], ['--port=--json'], ['--web-dir=--help']]) {
      const result = await runCli(['request', absent, request, ...args]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^error \[/);
    }
    // The real flag, beside such a value, still switches JSON mode on.
    expectJsonFailure(await runCli(['packet', absent, request, '--out=--json', '--json']), 'file-not-found');
    expect((await readdir(ws.dir)).sort()).toEqual(['fixture.pdf', 'request.json']);
  });
});
