/**
 * The build-time guard, `scripts/check-bundle.mjs`, must stop a bundle that
 * carries core's signing step even when minifying has renamed everything, and
 * must pass a bundle that does not.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PACKAGE, 'scripts/check-bundle.mjs');
const SIGN_SOURCE = fileURLToPath(new URL('../../core/src/sign.ts', import.meta.url));
// Under node_modules, so the workspace packages resolve from it and no source scan reads it.
const WORK = join(PACKAGE, 'node_modules', `.check-bundle-test-${randomBytes(6).toString('hex')}`);

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

function check(args: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Bundle one entry file the way a release build could: everything inlined and minified. */
async function bundle(name: string, source: string): Promise<string> {
  const entry = join(WORK, `${name}.ts`);
  await writeFile(entry, source);
  await build({
    entry: { [name]: entry },
    outDir: join(WORK, 'out'),
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // Bundle every import, except the two packages that the real builds keep external too.
    noExternal: [/^(?!pdfjs-dist|@napi-rs\/canvas)/],
    external: ['pdfjs-dist', '@napi-rs/canvas'],
    minify: true,
    splitting: false,
    sourcemap: false,
    clean: false,
    dts: false,
    silent: true,
    config: false,
  });
  return join(WORK, 'out', `${name}.js`);
}

let marker: string;

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  marker = /^export const SIGNING_CODE_MARKER = '([^']+)';/m.exec(await readFile(SIGN_SOURCE, 'utf8'))?.[1] ?? '';
  expect(marker.length).toBeGreaterThan(12);
});

afterAll(async () => {
  await rm(WORK, { recursive: true, force: true });
});

describe('scripts/check-bundle.mjs', () => {
  it('fails, and names the marker, for a minified bundle that includes the signing step', async () => {
    const file = await bundle(
      'with-signing',
      "import { finalizeDocument } from '@sign-pdf/core/sign';\n" +
        "process.stdout.write(process.argv.length > 99 ? String(finalizeDocument(new Uint8Array(), JSON.parse('{}'), JSON.parse('{}'))) : 'unused');\n",
    );
    const text = await readFile(file, 'utf8');
    expect(text.length).toBeGreaterThan(10_000);
    // Minifying removed the names the older check relied on; only the marker is left to find.
    expect(text).not.toContain('core/src/sign.ts');
    expect(text).not.toContain('core/src/write.ts');
    expect(text).toContain(marker);

    const result = await check([file]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(marker);
    expect(result.stderr).toContain("contains core's signing step");
    expect(result.stderr).toContain(file);
  });

  it('passes a minified bundle that uses only the index entry of core', async () => {
    const file = await bundle(
      'without-signing',
      "import { createPacket, inspectPdf, resolveRequest, sha256Hex, verifySignedPdf } from '@sign-pdf/core';\n" +
        'process.stdout.write([createPacket, inspectPdf, resolveRequest, sha256Hex, verifySignedPdf].map((fn) => typeof fn).join());\n',
    );
    const text = await readFile(file, 'utf8');
    expect(text.length).toBeGreaterThan(10_000);
    expect(text).not.toContain(marker);

    const result = await check([file]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('still catches the names in an unminified bundle, and fails without a readable bundle', async () => {
    const named = join(WORK, 'named.js');
    await writeFile(named, '// ../core/src/write.ts\nfunction finalizeDocument() {}\n');
    const byName = await check([named]);
    expect(byName.code).toBe(1);
    expect(byName.stderr).toContain('core/src/write.ts, finalizeDocument');

    const clean = join(WORK, 'clean.js');
    await writeFile(clean, 'console.log("nothing to see");\n');
    expect((await check([clean])).code).toBe(0);

    const usage = await check([]);
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('usage:');
    const missing = await check([join(WORK, 'absent.js')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read the bundle');
  });
});
