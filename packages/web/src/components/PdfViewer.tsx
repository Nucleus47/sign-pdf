/**
 * The one PDF viewer, used by the prepare and sign views.
 *
 * Every page gets a sized box at once (so field overlays exist for the whole
 * document) and its text layer (so the whole document's text is in the DOM).
 * The canvas of a page exists only while the page is near the visible part of
 * the scroll area: it is drawn when the page comes near and released when the
 * page leaves, so memory stays bounded however long the document is.
 */
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import type { PageInfo, Rect } from '@sign-pdf/spec';
import { failureOf, type Failure } from '../lib/errorReport.ts';
import { fieldZoom, fitWidthZoom, pinchZoom, stepZoom, ZOOM_MAX, ZOOM_MIN } from '../lib/geometry.ts';
import { loadPdfjs, openPdf, type PDFDocumentProxy, type RenderTask } from '../pdf/pdfjs.ts';
import { ErrorDetails } from './ErrorDetails.tsx';

export interface PdfViewerProps {
  pdf: Uint8Array;
  /** Accessible name of the document region. */
  label: string;
  /** Drawn above each page: the field canvas. `scale` is CSS pixels per point. */
  renderOverlay?: (page: PageInfo, scale: number) => ReactNode;
  /** Called once the page sizes are known. */
  onPages?: (pages: PageInfo[]) => void;
  /** Extra controls for the toolbar row. */
  toolbar?: ReactNode;
  /**
   * Make the page area a keyboard widget: focusable, named, and given these
   * attributes and key handler. Without it the area is only a scroll target.
   */
  regionProps?: HTMLAttributes<HTMLDivElement> & { 'aria-label': string };
  /**
   * Bring this rectangle (PDF points) to the middle of the view. A new `seq`
   * asks again. On a narrow screen the view also zooms in so the field and
   * the text around it can be read.
   */
  focus?: { rect: Rect; seq: number } | null;
}

/** Canvas backing stores above this many pixels fail on some phones. */
const MAX_CANVAS_PIXELS = 16_000_000;
const PAGE_GUTTER_PX = 32;
/** A page this close to the visible part of the scroll area has a canvas. */
const PRERENDER_MARGIN_PX = 600;

/** Give a canvas's backing store back at once instead of waiting for garbage collection. */
function releaseCanvases(holder: HTMLElement | null): void {
  if (!holder) return;
  for (const canvas of holder.querySelectorAll('canvas')) {
    canvas.width = 0;
    canvas.height = 0;
  }
  holder.replaceChildren();
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy; pages: PageInfo[] }
  | { status: 'error'; message: string; failure: Failure };

export function PdfViewer({ pdf, label, renderOverlay, onPages, toolbar, regionProps, focus }: PdfViewerProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [zoom, setZoom] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [centerOn, setCenterOn] = useState<{ rect: Rect; seq: number } | null>(null);
  const centered = useRef<number | null>(null);
  const onPagesRef = useRef(onPages);
  onPagesRef.current = onPages;

  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | undefined;
    setLoad({ status: 'loading' });
    setZoom(null);
    (async () => {
      try {
        const doc = await openPdf(pdf);
        if (cancelled) {
          // The effect was cleaned up while the document was still opening:
          // nothing else holds this document, so it is closed here.
          void doc.loadingTask.destroy();
          return;
        }
        opened = doc;
        const pages: PageInfo[] = [];
        for (let n = 1; n <= doc.numPages; n += 1) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: 1 });
          pages.push({ page: n, width: viewport.width, height: viewport.height });
        }
        if (cancelled) return;
        setLoad({ status: 'ready', doc, pages });
        onPagesRef.current?.(pages);
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : '';
        setLoad({
          status: 'error',
          message:
            name === 'PasswordException'
              ? 'This PDF is password-protected and cannot be shown.'
              : 'This PDF could not be shown. The file may be damaged.',
          failure: failureOf(error),
        });
      }
    })();
    return () => {
      cancelled = true;
      void opened?.loadingTask.destroy();
    };
  }, [pdf]);

  const firstWidth = load.status === 'ready' ? (load.pages[0]?.width ?? 612) : null;

  const fit = (): number => {
    const available = (scrollRef.current?.clientWidth ?? 800) - PAGE_GUTTER_PX;
    return fitWidthZoom(firstWidth ?? 612, available);
  };

  // First zoom: fit the page to the column, but do not blow a page up on a wide screen.
  useLayoutEffect(() => {
    if (firstWidth !== null && zoom === null) setZoom(Math.min(fit(), 1.5));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per document
  }, [firstWidth]);

  const scale = zoom ?? 1;
  const ready = load.status === 'ready' && zoom !== null;
  const zoomRef = useRef(scale);
  zoomRef.current = scale;

  // A field to show: zoom in on a narrow screen, then centre it (below, once the pages have their new size).
  useEffect(() => {
    if (!focus || !ready) return;
    const available = (scrollRef.current?.clientWidth ?? 800) - PAGE_GUTTER_PX;
    setZoom((current) => fieldZoom(current ?? 1, focus.rect.width, available));
    setCenterOn({ rect: focus.rect, seq: focus.seq });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new request is a new seq
  }, [focus?.seq, ready]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!centerOn || zoom === null || !scroller || centered.current === centerOn.seq) return;
    const pageBox = scroller.querySelector<HTMLElement>(`[data-page="${centerOn.rect.page}"]`);
    if (!pageBox) return;
    centered.current = centerOn.seq;
    const view = scroller.getBoundingClientRect();
    const box = pageBox.getBoundingClientRect();
    const { rect } = centerOn;
    const x = box.left - view.left + scroller.scrollLeft + (rect.x + rect.width / 2) * zoom;
    const y = box.top - view.top + scroller.scrollTop + (rect.y + rect.height / 2) * zoom;
    scroller.scrollTo?.({ left: x - scroller.clientWidth / 2, top: y - scroller.clientHeight / 2 });
  }, [centerOn, zoom]);

  // Two-finger pinch zooms the document, not the whole app, and keeps the
  // point between the fingers in place. Touch events, because the browser
  // cancels a pointer once it starts panning with it.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !ready) return;
    let pinch: { zoom: number; distance: number } | null = null;
    const spread = (touches: TouchList) => {
      const [a, b] = [touches[0], touches[1]];
      return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
    };
    const middle = (touches: TouchList) => {
      const [a, b] = [touches[0], touches[1]];
      const view = scroller.getBoundingClientRect();
      return a && b
        ? { x: (a.clientX + b.clientX) / 2 - view.left, y: (a.clientY + b.clientY) / 2 - view.top }
        : { x: 0, y: 0 };
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length === 2) pinch = { zoom: zoomRef.current, distance: spread(event.touches) };
    };
    const move = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const next = pinchZoom(pinch.zoom, pinch.distance, spread(event.touches));
      const current = zoomRef.current;
      if (next === current) return;
      const point = middle(event.touches);
      const ratio = next / current;
      const left = (scroller.scrollLeft + point.x) * ratio - point.x;
      const top = (scroller.scrollTop + point.y) * ratio - point.y;
      zoomRef.current = next;
      setZoom(next);
      requestAnimationFrame(() => scroller.scrollTo?.({ left, top }));
    };
    const end = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };
    scroller.addEventListener('touchstart', start, { passive: true });
    scroller.addEventListener('touchmove', move, { passive: false });
    scroller.addEventListener('touchend', end, { passive: true });
    scroller.addEventListener('touchcancel', end, { passive: true });
    return () => {
      scroller.removeEventListener('touchstart', start);
      scroller.removeEventListener('touchmove', move);
      scroller.removeEventListener('touchend', end);
      scroller.removeEventListener('touchcancel', end);
    };
  }, [ready]);

  return (
    <section className="viewer" aria-label={label}>
      <div className="viewer-toolbar" role="toolbar" aria-label="Document view">
        <div className="zoom-controls">
          <button
            type="button"
            className="button quiet icon"
            data-testid="zoom-out"
            aria-label="Zoom out"
            disabled={scale <= ZOOM_MIN}
            onClick={() => setZoom(stepZoom(scale, -1))}
          >
            <span aria-hidden="true">−</span>
          </button>
          <output className="zoom-value" data-testid="zoom-value" aria-label="Zoom level">
            {Math.round(scale * 100)}%
          </output>
          <button
            type="button"
            className="button quiet icon"
            data-testid="zoom-in"
            aria-label="Zoom in"
            disabled={scale >= ZOOM_MAX}
            onClick={() => setZoom(stepZoom(scale, 1))}
          >
            <span aria-hidden="true">+</span>
          </button>
          <button type="button" className="button quiet" data-testid="zoom-fit" onClick={() => setZoom(fit())}>
            Fit width
          </button>
        </div>
        {toolbar}
      </div>
      <div
        className="viewer-scroll"
        ref={scrollRef}
        data-testid="viewer-scroll"
        tabIndex={regionProps ? 0 : -1}
        {...regionProps}
      >
        {load.status === 'loading' && (
          <p className="viewer-message" role="status">
            Opening the document…
          </p>
        )}
        {load.status === 'error' && (
          <div className="viewer-message form-error" role="alert" data-testid="viewer-error">
            <p>{load.message}</p>
            <ErrorDetails failure={load.failure} file={{ extension: '', bytes: pdf.length }} />
          </div>
        )}
        {load.status === 'ready' &&
          zoom !== null &&
          load.pages.map((page) => (
            <PdfPage key={page.page} doc={load.doc} page={page} total={load.pages.length} scale={zoom}>
              {renderOverlay?.(page, zoom)}
            </PdfPage>
          ))}
      </div>
    </section>
  );
}

interface PdfPageProps {
  doc: PDFDocumentProxy;
  page: PageInfo;
  total: number;
  scale: number;
  children?: ReactNode;
}

function PdfPage({ doc, page, total, scale, children }: PdfPageProps) {
  const rootRef = useRef<HTMLElement>(null);
  const canvasHolderRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const textDone = useRef(false);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const latest = entries[entries.length - 1];
        if (latest) setNear(latest.isIntersecting);
      },
      // The margin grows the scroll area, not the window: pages are clipped by it.
      { root: element.closest('.viewer-scroll'), rootMargin: `${PRERENDER_MARGIN_PX}px 0px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Canvas: drawn while the page is near, re-rendered when the zoom changes.
  // The old bitmap stays (stretched) until the new one is ready, so zooming
  // does not flash white. When the page leaves the margin the canvas is
  // released; the page box keeps its size, so nothing moves.
  useEffect(() => {
    if (!near) {
      releaseCanvases(canvasHolderRef.current);
      rootRef.current?.removeAttribute('data-rendered');
      // Let pdf.js drop what it kept for drawing this page (images, operator list).
      void doc.getPage(page.page).then(
        (pdfPage) => void pdfPage.cleanup(),
        () => undefined,
      );
      return;
    }
    let cancelled = false;
    let task: RenderTask | undefined;
    (async () => {
      const pdfPage = await doc.getPage(page.page);
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const cap = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
      const outputScale = Math.min(dpr, cap);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.setAttribute('aria-hidden', 'true');
      task = pdfPage.render({
        canvas,
        viewport,
        transform: [outputScale, 0, 0, outputScale, 0, 0],
      });
      await task.promise;
      if (cancelled) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      const holder = canvasHolderRef.current;
      if (!holder) return;
      releaseCanvases(holder);
      holder.append(canvas);
      rootRef.current?.setAttribute('data-rendered', 'true');
    })().catch((error: unknown) => {
      // A cancelled render is expected when the zoom changes or the page scrolls away mid-render.
      if (!cancelled && !(error instanceof Error && error.name === 'RenderingCancelledException')) {
        console.error('page render failed', error);
      }
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page.page, scale, near]);

  // Text layer: built once per page, for every page and not only the visible
  // ones, so the whole document's text is in the DOM and the accessibility
  // tree. It scales through a CSS variable, so a zoom change needs no rebuild.
  // pdf.js sizes the container with the page's unrotated dimensions and sets
  // `data-main-rotation`; the rules in app.css turn it, as pdf.js's viewer does.
  useEffect(() => {
    if (textDone.current) return;
    const container = textRef.current;
    if (!container) return;
    let cancelled = false;
    let layer: { cancel(): void } | undefined;
    (async () => {
      const [pdfjs, pdfPage] = await Promise.all([loadPdfjs(), doc.getPage(page.page)]);
      if (cancelled) return;
      const textLayer = new pdfjs.TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container,
        viewport: pdfPage.getViewport({ scale: 1 }),
      });
      layer = textLayer;
      await textLayer.render();
      if (!cancelled) textDone.current = true;
    })().catch((error: unknown) => {
      if (!cancelled) console.error('text layer failed', error);
    });
    return () => {
      cancelled = true;
      if (!textDone.current) {
        layer?.cancel();
        container.replaceChildren();
      }
    };
  }, [doc, page.page]);

  return (
    <section
      ref={rootRef}
      className="pdf-page"
      aria-label={`Page ${page.page} of ${total}`}
      data-testid={`pdf-page-${page.page}`}
      data-page={page.page}
      style={{ width: page.width * scale, height: page.height * scale }}
    >
      <div className="pdf-canvas" ref={canvasHolderRef} />
      <div
        className="textLayer"
        ref={textRef}
        style={{ ['--total-scale-factor' as string]: String(scale) }}
      />
      {children}
    </section>
  );
}
