/**
 * The browser side of render_preview: core draws, this module supplies the
 * canvas and the app's own pdf.js (same worker, same-origin assets). Nothing
 * here is shown on the page; the PNGs go to the agent only.
 */
import type { CanvasLike, PdfjsRenderModule, PreviewRenderer } from '@sign-pdf/core';
import { loadPdfjs, pdfjsDocumentOptions } from '../pdf/pdfjs.ts';

function encodePng(canvas: CanvasLike): Promise<Uint8Array> {
  // Only canvases made by createCanvas below reach here.
  const element = canvas as unknown as HTMLCanvasElement;
  return new Promise((resolve, reject) => {
    element.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The browser could not encode the preview as PNG.'));
        return;
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, 'image/png');
  });
}

export async function browserPreviewRenderer(): Promise<PreviewRenderer> {
  // The cast narrows pdf.js to the part of its API core declares.
  const pdfjs = (await loadPdfjs()) as unknown as PdfjsRenderModule;
  return {
    createCanvas: (width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      // The structural Context2d is a subset of CanvasRenderingContext2D.
      return canvas as unknown as CanvasLike;
    },
    encodePng,
    pdfjs,
    documentOptions: pdfjsDocumentOptions(),
  };
}
