/** The pdf.js worker, with the polyfills it needs on older iPhones installed first. */
import './streamIterator.ts';
import './legacyPolyfills.ts';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
