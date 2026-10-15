import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { requestSha256, resolveRequest } from './index.ts';
import { SIGNING_CODE_MARKER, finalizeDocument } from './sign.ts';
import { humanInput, makePng, requestFor } from './test-helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every source file a bundler would pull in from `entry`: relative imports and
 * re-exports that survive compilation. `import type` / `export type`
 * statements are erased, so they are not followed.
 */
function moduleGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [resolve(here, entry)];
  const statement = /(?:^|[;\n])\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;
  const dynamic = /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    for (const match of source.matchAll(statement)) {
      if (match[1] === undefined && match[2] !== undefined) queue.push(resolve(dirname(file), match[2]));
    }
    for (const match of source.matchAll(dynamic)) {
      if (match[1] !== undefined) queue.push(resolve(dirname(file), match[1]));
    }
  }
  return seen;
}

function filesContaining(graph: Map<string, string>, text: string): string[] {
  return [...graph].filter(([, source]) => source.includes(text)).map(([file]) => file);
}

describe('signing code marker', () => {
  it('has the documented value and is attached to finalizeDocument at runtime', () => {
    expect(SIGNING_CODE_MARKER).toBe('sign-pdf:human-signing-code');
    expect(finalizeDocument.signingCodeMarker).toBe(SIGNING_CODE_MARKER);
  });

  it('is absent from everything reachable from the index entry', () => {
    const graph = moduleGraph('index.ts');
    // The walk really followed imports: these are known members of the prepare side.
    expect([...graph.keys()]).toEqual(
      expect.arrayContaining([resolve(here, 'resolve.ts'), resolve(here, 'verify.ts'), resolve(here, 'packet.ts')]),
    );
    expect(graph.has(resolve(here, 'sign.ts'))).toBe(false);
    expect(graph.has(resolve(here, 'write.ts'))).toBe(false);
    // The hand-off PDF takes signature images, so building it is signing code too.
    expect(graph.has(resolve(here, 'handoff.ts'))).toBe(false);
    expect(graph.has(resolve(here, 'draw.ts'))).toBe(false);
    expect(filesContaining(graph, SIGNING_CODE_MARKER)).toEqual([]);
  });

  it('is present in the sign entry, and only there', () => {
    const graph = moduleGraph('sign.ts');
    expect(graph.has(resolve(here, 'write.ts'))).toBe(true);
    expect(graph.has(resolve(here, 'handoff.ts'))).toBe(true);
    expect(filesContaining(graph, SIGNING_CODE_MARKER)).toEqual([resolve(here, 'sign.ts')]);
  });
});

describe('requestSha256', () => {
  it('equals the requestSha256 of the audit record written at signing', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const pdf = await doc.save();
    const request = await requestFor(pdf, [
      {
        id: 'sig',
        type: 'signature',
        assignee: 'human',
        placement: { kind: 'rect', page: 1, x: 72, y: 600, width: 200, height: 50 },
      },
    ]);
    const resolved = await resolveRequest(pdf, request);
    const result = await finalizeDocument(
      pdf,
      resolved,
      humanInput({ signatures: { sig: { png: makePng(40, 20), method: 'drawn' } } }),
    );
    expect(await requestSha256(request)).toBe(result.audit.requestSha256);
    expect(await requestSha256(resolved.request)).toBe(result.audit.requestSha256);
    // Key order does not matter; content does.
    const reordered = { fields: request.fields, document: request.document, version: request.version };
    expect(await requestSha256(reordered)).toBe(result.audit.requestSha256);
    const other = { ...request, document: { ...request.document, name: 'other.pdf' } };
    expect(await requestSha256(other)).not.toBe(result.audit.requestSha256);
  });

  it('rejects an invalid request', async () => {
    // Deliberately malformed: the cast stands in for input that skipped type checking.
    await expect(requestSha256({ version: 1 } as never)).rejects.toMatchObject({ name: 'SignPdfError' });
  });
});
