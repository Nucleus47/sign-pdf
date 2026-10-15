/**
 * The native canvas is needed by `preview` only. With the module made
 * unloadable, every other command still works and `preview` says what is wrong.
 */
import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixturePdf, requestFor, runCli, workspace, type Workspace } from './test-helpers.ts';

vi.mock('@napi-rs/canvas', () => {
  throw new Error('simulated: native binding missing');
});

let ws: Workspace;

beforeEach(async () => {
  ws = await workspace();
});

afterEach(async () => {
  await ws.cleanup();
});

describe('without the native canvas', () => {
  it('inspect, validate and packet work; preview fails with preview-unavailable', async () => {
    const pdf = await fixturePdf();
    const pdfPath = await ws.write('fixture.pdf', pdf);
    const requestPath = await ws.write('request.json', JSON.stringify(await requestFor(pdf)));

    expect((await runCli(['inspect', pdfPath, '--json'])).code).toBe(0);
    expect((await runCli(['validate', pdfPath, requestPath])).code).toBe(0);
    expect((await runCli(['packet', pdfPath, requestPath])).code).toBe(0);

    const preview = await runCli(['preview', pdfPath, requestPath, '--out', ws.path('preview'), '--json']);
    expect(preview.code).toBe(1);
    const error = preview.json<{ ok: boolean; error: { code: string; message: string; hint: string } }>();
    expect(Object.keys(error)).toEqual(['ok', 'error']);
    expect(error.ok).toBe(false);
    expect(error.error.code).toBe('preview-unavailable');
    expect(error.error.message).toContain('@napi-rs/canvas');
    expect(error.error.hint).toContain('Every other command works');
    expect(preview.stderr).toBe(`error [preview-unavailable]: ${error.error.message}\n`);
    // No image was written.
    await expect(readdir(ws.path('preview'))).rejects.toThrow();

    const text = await runCli(['preview', pdfPath, requestPath, '--out', ws.path('preview')]);
    expect(text.code).toBe(1);
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain('error [preview-unavailable]');
    expect(text.stderr).toContain('hint: ');
  });

  it('the other commands still give their --json results', async () => {
    const pdf = await fixturePdf();
    const pdfPath = await ws.write('fixture.pdf', pdf);
    const requestPath = await ws.write('request.json', JSON.stringify(await requestFor(pdf)));
    for (const args of [['inspect', pdfPath], ['schema'], ['validate', pdfPath, requestPath], ['packet', pdfPath, requestPath]]) {
      const result = await runCli([...args, '--json']);
      expect(result.code, args[0]).toBe(0);
      expect(result.json()['ok'], args[0]).toBe(true);
    }
    const unsigned = await runCli(['verify', pdfPath, '--json']);
    expect(unsigned.code).toBe(1);
    expect(unsigned.json()).toMatchObject({ ok: false, error: { code: 'not-signed' } });
  });
});
