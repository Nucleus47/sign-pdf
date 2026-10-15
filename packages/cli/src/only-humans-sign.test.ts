/**
 * Only a human signs. The signing step lives in `@sign-pdf/core/sign`; no
 * shipped source file of the CLI or the MCP server may import it. Test files
 * may, to play the human in the hand-off tests.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../..', import.meta.url));
// check-bundle.mjs is the build-time half of this guard: it names the same markers to search the bundles for them.
const isTestFile = (name: string) => /\.test\.ts$/.test(name) || name === 'test-helpers.ts' || name === 'check-bundle.mjs';

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|mts|js|mjs|json)$/.test(entry.name) && !isTestFile(entry.name)) out.push(path);
  }
  return out;
}

// Any way of reaching the signing code: the public subpath or core's internal files.
const FORBIDDEN = /core\/sign\b|core\/src\/(sign|write)\b|finalizeDocument/;

describe('only a human signs', () => {
  for (const name of ['cli', 'mcp']) {
    it(`no shipped file of packages/${name} reaches core's signing step`, async () => {
      const files = await sourceFiles(join(PACKAGES, name));
      expect(files.length).toBeGreaterThan(3);
      const offenders: string[] = [];
      for (const file of files) {
        if (FORBIDDEN.test(await readFile(file, 'utf8'))) offenders.push(file);
      }
      expect(offenders).toEqual([]);
    });
  }

  it('the guard itself catches an import of the signing step', () => {
    expect(FORBIDDEN.test("import { finalizeDocument } from '@sign-pdf/core/sign';")).toBe(true);
    expect(FORBIDDEN.test("await import('@sign-pdf/core/sign')")).toBe(true);
    expect(FORBIDDEN.test("import { x } from '../../core/src/write.ts';")).toBe(true);
    expect(FORBIDDEN.test("import { inspectPdf } from '@sign-pdf/core';")).toBe(false);
  });
});
