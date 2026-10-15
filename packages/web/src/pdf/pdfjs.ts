/**
 * pdf.js, loaded on demand. The worker is a same-origin asset emitted by Vite;
 * fonts, CMaps and image decoders are copied to /pdfjs/ at build time
 * (see vite.config.ts). Nothing is fetched from another origin.
 *
 * The legacy build: the modern one calls JavaScript features that shipping
 * Safari on iPhone lacks (such as Map.prototype.getOrInsertComputed), and
 * fails there with "undefined is not a function". See also ./streamIterator.ts,
 * ./legacyPolyfills.ts and docs/browser-support.md.
 */
import './streamIterator.ts';
import './legacyPolyfills.ts';
import { loadCode } from '../lib/release.ts';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
export type PdfjsModule = typeof import('pdfjs-dist');

let loading: Promise<PdfjsModule> | undefined;

export function loadPdfjs(): Promise<PdfjsModule> {
  loading ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      loadCode(() => import('pdfjs-dist/legacy/build/pdf.mjs')),
      // Ours wraps pdf.js's worker to install the polyfills first.
      loadCode(() => import('./pdf.worker.ts?worker&url')),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  // A failed load is not kept: the next call tries again.
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

const assetBase = `${import.meta.env.BASE_URL}pdfjs/`;

/** The `getDocument` options every page render uses: same-origin assets, and no XFA scripts. */
export function pdfjsDocumentOptions(): Record<string, unknown> {
  return {
    // Scripts inside a PDF are never run.
    enableXfa: false,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    iccUrl: `${assetBase}iccs/`,
  };
}

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    ...pdfjsDocumentOptions(),
    // pdf.js transfers the buffer to its worker, so it gets its own copy.
    data: bytes.slice(),
  }).promise;
}
