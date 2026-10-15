# Browser support

The web app supports Safari and iOS Safari 16.4 or later, and Chrome 110 or later.

## One declaration

The target is declared once, as `browserslist` in [packages/web/package.json](../packages/web/package.json).
Everything else reads it:

- **Build.** [packages/web/browserTargets.ts](../packages/web/browserTargets.ts) turns it into the esbuild targets that `vite.config.ts` builds for, such as `safari16.4`. Vite lowers newer syntax to that level.
- **Bundle check.** [packages/web/scripts/check-bundle.mjs](../packages/web/scripts/check-bundle.mjs) runs after every `vite build` (the web `build` script, so in `pnpm check`, CI and the deploy). It runs [es-check](https://github.com/yowainwright/es-check) on each chunk in `dist/assets/` for syntax and for JavaScript built-ins, such as `Map.prototype.getOrInsertComputed`, that the target lacks.
- **Source lint.** `pnpm lint` runs [eslint-plugin-compat](https://github.com/amilajack/eslint-plugin-compat) on `packages/web/src`. It reports web APIs the target lacks, such as `CookieStore`. It does not see new methods on built-ins.
- **Types.** The TypeScript library in `packages/web/tsconfig.json` is ES2023 and DOM, without `DOM.AsyncIterable`. A call to an ES2024+ built-in, or `for await` over a `ReadableStream`, is a type error.

To change the target, edit `browserslist`, then run `pnpm check`.

## What the checks cannot see

Static checks cannot tell what a `for await` loop iterates. Safari cannot iterate a `ReadableStream`, and pdf.js does it to read page text and to decompress images. The bundle check therefore requires the stream iteration polyfill wherever a chunk has a `for await` loop. The end-to-end test `packages/web/e2e/older-browsers.spec.ts` removes the features Safari 16.4 lacks in the page and in the pdf.js worker, opens PDFs, and checks that every removed feature pdf.js needs is back in both.

## pdf.js exceptions

The app loads the pdf.js legacy build. Its chunks (`pdf-*.js` and `pdf.worker-*.js`) call features the target lacks. The bundle check allows each one only while the chunk holds the evidence below. If an upgrade, or a switch to the modern pdf.js build, removes the evidence, the check fails.

| Features | Why it is safe | Evidence the check requires |
| --- | --- | --- |
| `Map`/`WeakMap` `getOrInsert`, `getOrInsertComputed`; `Math.sumPrecise`; `Promise.try`; `Set` methods; `Uint8Array` base64 and hex; the global `Iterator` | pdf.js bundles core-js, which installs each one when the browser lacks it. | The core-js definition, such as `{target:"Map",...},{getOrInsertComputed:`, in the same chunk. |
| `JSON.rawJSON`, `JSON.isRawJSON` | Used only in core-js's own feature test, which catches the error. | That feature test in the chunk. |
| `Float16Array` | pdf.js checks `typeof Float16Array` first and uses `Float32Array` without it. | That check in the chunk. |
| `Promise.withResolvers`, `ArrayBuffer.prototype.transferToFixedLength` | pdf.js does not polyfill them. [src/pdf/legacyPolyfills.ts](../packages/web/src/pdf/legacyPolyfills.ts) installs them before pdf.js loads, in the page and in the worker. | The polyfill in the worker chunk itself; for the page, anywhere in the build. |

Our own chunks get no exceptions.

## Polyfills

The page ([src/pdf/pdfjs.ts](../packages/web/src/pdf/pdfjs.ts)) and the worker ([src/pdf/pdf.worker.ts](../packages/web/src/pdf/pdf.worker.ts)) each import these before pdf.js:

- [src/pdf/streamIterator.ts](../packages/web/src/pdf/streamIterator.ts): `for await` over a `ReadableStream`.
- [src/pdf/legacyPolyfills.ts](../packages/web/src/pdf/legacyPolyfills.ts): `Promise.withResolvers` and `ArrayBuffer.prototype.transferToFixedLength`.

A worker shares no globals with the page, so each must be imported in both.
