import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from '../pdf/pdfjs.ts';
import { PdfViewer } from './PdfViewer.tsx';

// pdf.js needs a real browser; these tests only follow the document's lifetime.
const pending: { resolve: (doc: PDFDocumentProxy) => void }[] = [];
vi.mock('../pdf/pdfjs.ts', () => ({
  loadPdfjs: () => new Promise(() => undefined),
  openPdf: () =>
    new Promise<PDFDocumentProxy>((resolve) => {
      pending.push({ resolve });
    }),
}));

function fakeDocument() {
  const destroy = vi.fn(() => Promise.resolve());
  const doc = {
    numPages: 1,
    loadingTask: { destroy },
    getPage: () =>
      Promise.resolve({
        getViewport: () => ({ width: 612, height: 792 }),
        cleanup: () => true,
        render: () => ({ promise: new Promise(() => undefined), cancel: () => undefined }),
      }),
  } as unknown as PDFDocumentProxy; // a double: only what the viewer's load path touches
  return { doc, destroy };
}

afterEach(() => {
  pending.length = 0;
});

describe('PdfViewer document lifetime', () => {
  it('closes a document that finishes opening after the viewer has gone', async () => {
    const view = render(<PdfViewer pdf={new Uint8Array([1])} label="Document: test.pdf" />);
    expect(pending).toHaveLength(1);
    view.unmount();

    const { doc, destroy } = fakeDocument();
    await act(async () => {
      pending[0]?.resolve(doc);
      await Promise.resolve();
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('closes the first document when another PDF replaces it mid-open', async () => {
    const view = render(<PdfViewer pdf={new Uint8Array([1])} label="Document: test.pdf" />);
    view.rerender(<PdfViewer pdf={new Uint8Array([2])} label="Document: test.pdf" />);
    expect(pending).toHaveLength(2);

    const first = fakeDocument();
    const second = fakeDocument();
    await act(async () => {
      pending[0]?.resolve(first.doc);
      pending[1]?.resolve(second.doc);
      await Promise.resolve();
    });
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).not.toHaveBeenCalled();
    expect(await screen.findByTestId('pdf-page-1')).toBeInTheDocument();

    view.unmount();
    expect(second.destroy).toHaveBeenCalledTimes(1);
  });
});
