#!/usr/bin/env node
/**
 * Fails when the built app (dist/) needs syntax or JavaScript built-ins beyond
 * the browser target declared as `browserslist` in package.json.
 * Run after `vite build`: `pnpm --filter @sign-pdf/web check:bundle`.
 * See docs/browser-support.md.
 *
 * es-check reads every chunk and reports each feature the target lacks. Our own
 * chunks get no exceptions. The pdf.js legacy chunks get the exceptions below,
 * and only while the chunk still holds the evidence that makes each one safe:
 * an upgrade or a switch to the modern pdf.js build that drops a polyfill makes
 * this check fail again.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from 'es-check';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets = join(root, 'dist', 'assets');

/** The pdf.js legacy chunks: pdf.mjs (pdf-*.js) and our worker wrapper (pdf.worker-*.js). */
const pdfjsChunk = /^pdf(\.worker)?-[\w-]+\.js$/;

// core-js registers a polyfill as `$({target: "Map", proto: true, ...}, {getOrInsertComputed: ...})`;
// minified: `{target:"Map",proto:!0,...},{getOrInsertComputed:`.
const coreJs = (target, method) => new RegExp(`\\{target:"${target}",[^}]*\\},\\{(?:[^}]*,)?${method}:`);

/**
 * Feature name (as es-check reports it) -> why it is safe in a pdf.js legacy chunk,
 * and the text that must be in the chunk for that reason to hold.
 */
const pdfjsAllowlist = {
  // core-js, bundled inside the pdf.js legacy build, installs these when the browser lacks them.
  MapGetOrInsertComputed: { why: 'core-js polyfill in the chunk', evidence: coreJs('Map', 'getOrInsertComputed') },
  MapGetOrInsert: { why: 'core-js polyfill in the chunk', evidence: coreJs('Map', 'getOrInsert') },
  MathSumPrecise: { why: 'core-js polyfill in the chunk', evidence: coreJs('Math', 'sumPrecise') },
  PromiseTry: { why: 'core-js polyfill in the chunk', evidence: coreJs('Promise', 'try') },
  SetIntersection: { why: 'core-js polyfill in the chunk', evidence: coreJs('Set', 'intersection') },
  Uint8ArrayFromBase64: { why: 'core-js polyfill in the chunk', evidence: coreJs('Uint8Array', 'fromBase64') },
  Uint8ArrayToBase64: { why: 'core-js polyfill in the chunk', evidence: coreJs('Uint8Array', 'toBase64') },
  Uint8ArrayToHex: { why: 'core-js polyfill in the chunk', evidence: coreJs('Uint8Array', 'toHex') },
  Uint8ArraySetFromBase64: { why: 'core-js polyfill in the chunk', evidence: coreJs('Uint8Array', 'setFromBase64') },
  Uint8ArraySetFromHex: { why: 'core-js polyfill in the chunk', evidence: coreJs('Uint8Array', 'setFromHex') },
  // The global Iterator and its helpers (es.iterator.constructor).
  Iterator: { why: 'core-js polyfill in the chunk', evidence: /\{global:!0,constructor:!0,forced:[^}]*\},\{Iterator:/ },
  // Read only inside core-js's own feature test for JSON.parse and JSON.stringify, which catches the error.
  JSONRawJSON: { why: 'core-js feature test only', evidence: /JSON\.rawJSON\(\w+\);return!JSON\.isRawJSON\(/ },
  JSONIsRawJSON: { why: 'core-js feature test only', evidence: /JSON\.rawJSON\(\w+\);return!JSON\.isRawJSON\(/ },
  // pdf.js uses Float16Array only after `typeof Float16Array !== "undefined"` (FeatureTest.isFloat16ArraySupported).
  Float16Array: { why: 'pdf.js feature-detects it', evidence: /"isFloat16ArraySupported",typeof Float16Array<"u"/ },
  // Not polyfilled by pdf.js: src/pdf/legacyPolyfills.ts installs these before pdf.js loads,
  // on the main thread (src/pdf/pdfjs.ts, another chunk) and in the worker (src/pdf/pdf.worker.ts).
  // For pdf.mjs the evidence is looked for in the whole build, since pdfjs.ts is another chunk;
  // the older-browsers end-to-end test proves it runs first.
  PromiseWithResolvers: { why: 'src/pdf/legacyPolyfills.ts', evidence: /defineProperty\(\w+,"withResolvers",/, inBuild: true },
  ArrayBufferTransferToFixedLength: { why: 'src/pdf/legacyPolyfills.ts', evidence: /defineProperty\(\w+,"transferToFixedLength",/, inBuild: true },
};

const files = readdirSync(assets).filter((file) => file.endsWith('.js'));
if (files.length === 0) {
  console.error(`check-bundle: no JavaScript in ${assets}; run vite build first.`);
  process.exit(1);
}

// The target, read from the one declaration in package.json.
const { browserslist } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const browserslistQuery = [browserslist].flat().join(', ');
console.log(`check-bundle: target ${browserslistQuery}`);

const sources = new Map(files.map((file) => [file, readFileSync(join(assets, file), 'utf8')]));
// The page's code: every chunk but the worker's, which runs apart and cannot polyfill the page.
const build = files
  .filter((file) => !file.startsWith('pdf.worker-'))
  .map((file) => sources.get(file))
  .join('\n');

// es-check cannot tell what a `for await` loop iterates. pdf.js iterates ReadableStreams,
// which Safari cannot do and Chrome can from 124: src/pdf/streamIterator.ts adds it. So every chunk
// with a `for await` loop needs that polyfill: in its own chunk for a worker, anywhere for the page.
const forAwait = /\bfor\s*await\s*\(/;
const streamIterator = /\["values",Symbol\.asyncIterator\]\)Object\.defineProperty\(/;

let failed = false;
for (const file of files.sort()) {
  const path = join(assets, file);
  const code = sources.get(file) ?? '';
  // A worker shares no globals with the page: its polyfills must be in its own chunk.
  const isWorker = file.startsWith('pdf.worker-');
  const ignore = [];
  if (pdfjsChunk.test(file)) {
    for (const [feature, { evidence, inBuild }] of Object.entries(pdfjsAllowlist)) {
      if (evidence.test(inBuild && !isWorker ? build : code)) ignore.push(feature);
    }
  }
  const problems = [];
  if (forAwait.test(code) && !streamIterator.test(isWorker ? code : build)) {
    problems.push(`a for await loop, and no ReadableStream iteration polyfill (src/pdf/streamIterator.ts) ${isWorker ? 'in this worker' : 'in the build'}.`);
  }
  const result = runChecks(
    [{ ecmaVersion: 'checkBrowser', module: true, checkFeatures: true, files: [path], ignore: ignore.join(','), browserslistQuery, noCache: true }],
    { logger: null },
  );
  for (const { err } of result.errors ?? []) problems.push(err?.message ?? String(err));
  if (problems.length === 0) {
    console.log(`ok   ${file}${ignore.length ? ` (pdf.js exceptions with evidence: ${ignore.join(', ')})` : ''}`);
    continue;
  }
  failed = true;
  for (const problem of problems) console.error(`FAIL ${file}: ${problem}`);
}

if (failed) {
  console.error('\ncheck-bundle: the build needs features the browser target lacks. See docs/browser-support.md.');
  process.exit(1);
}
