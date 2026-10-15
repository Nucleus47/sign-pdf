/**
 * Render pages of a PDF to PNG with the request's field boxes drawn on top, so
 * an agent can look at its own layout before it asks the human to sign.
 *
 * Each image is the page at `scale` pixels per point, with a ruler along the
 * top and left edges labelled in the spec's coordinates (PDF points, top-left
 * origin, y down) and a light grid. A point (x, y) on the page is drawn at pixel
 * (origin.x + x * scale, origin.y + y * scale).
 *
 * The caller supplies the canvas and the pdf.js build (`PreviewRenderer`), so
 * this module runs in Node (with a native canvas) and in a browser alike. It
 * imports no canvas, no pdf.js and nothing from Node or the DOM.
 */
import type { Field, FieldType, Rect, ResolvedRequest } from '@sign-pdf/spec';
import type { PlacementCandidate } from './candidates.ts';
import { SignPdfError } from './errors.ts';

export const DEFAULT_PREVIEW_SCALE = 1.5;
export const MIN_PREVIEW_SCALE = 0.5;
export const MAX_PREVIEW_SCALE = 4;
/** Width of the left ruler and height of the top ruler, in pixels. */
export const RULER_LEFT = 40;
export const RULER_TOP = 24;
const MAX_PIXELS = 40_000_000;

/** Outline colour per field type. Each contrasts with black text on white paper. */
export const FIELD_COLORS: Record<FieldType, readonly [number, number, number]> = {
  signature: [214, 0, 108],
  initials: [128, 0, 200],
  text: [0, 87, 217],
  date: [0, 128, 64],
  checkbox: [196, 88, 0],
};

/**
 * Outline colour of a placement candidate mark: a dark slate unlike every field
 * colour, drawn dotted, so it does not read as a field or an anchor candidate.
 */
export const PLACEMENT_CANDIDATE_COLOR: readonly [number, number, number] = [45, 55, 72];

/** The places an ambiguous anchor matched (an 'anchor-ambiguous' warning). Candidate n is `occurrence: n`. */
export interface AnchorCandidates {
  fieldId: string;
  candidates: readonly Rect[];
}

export interface PreviewOptions {
  /** 1-based pages to render. Default: every page that has a field or a candidate mark. */
  pages?: readonly number[];
  /** Pixels per PDF point. Default 1.5. */
  scale?: number;
  /** Drawn as dashed outlines numbered "<field id> #n", in the field's colour. */
  anchorCandidates?: readonly AnchorCandidates[];
  /** Placement candidates, drawn as dotted outlines tagged "C<n>": candidate n is `placementCandidates[n - 1]`. */
  placementCandidates?: readonly PlacementCandidate[];
}

/** What the preview draws fields on: the pages and the resolved fields. A request is optional. */
export type PreviewLayout = Pick<ResolvedRequest, 'pages' | 'fields'>;

export interface PreviewPage {
  page: number;
  png: Uint8Array;
  /** Image size in pixels, rulers included. */
  width: number;
  height: number;
  /** Pixels per PDF point. */
  scale: number;
  /** Pixel position of the page's top-left corner (spec coordinate 0, 0). */
  origin: { x: number; y: number };
  /** Page size in points. */
  pageWidth: number;
  pageHeight: number;
  /** Ids of the fields drawn on this page. */
  fieldIds: string[];
  /** Anchor candidates marked on this page: the field and the occurrence number that selects each. */
  candidates: Array<{ fieldId: string; occurrence: number }>;
  /** Numbers of the placement candidates marked on this page ("C<n>"). */
  placementCandidates: number[];
}

// The canvas and pdf.js types are declared structurally: only this small part
// of their API is used, and the caller supplies both.
/** The part of a 2D canvas context the preview draws with. */
export interface Context2d {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textBaseline: string;
  textAlign: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  stroke(): void;
  clip(): void;
  save(): void;
  restore(): void;
  setLineDash(segments: number[]): void;
  drawImage(image: unknown, x: number, y: number): void;
}

/** A canvas the renderer creates. pdf.js draws into it, and `encodePng` turns it into a PNG. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): Context2d;
}

interface PdfjsViewport {
  width: number;
  height: number;
}

interface PdfjsRenderPage {
  getViewport(options: { scale: number }): PdfjsViewport;
  render(options: { canvas: unknown; canvasContext: unknown; viewport: PdfjsViewport }): { promise: Promise<unknown> };
}

/** The part of a pdf.js build that renders pages. */
export interface PdfjsRenderModule {
  getDocument(source: Record<string, unknown>): {
    promise: Promise<{ numPages: number; getPage(page: number): Promise<PdfjsRenderPage> }>;
    destroy(): Promise<void>;
  };
}

/** What `renderPreview` draws with. The caller loads it once and passes it in. */
export interface PreviewRenderer {
  createCanvas(width: number, height: number): CanvasLike;
  encodePng(canvas: CanvasLike): Promise<Uint8Array>;
  /** A pdf.js build that can render pages with the canvases `createCanvas` makes. */
  pdfjs: PdfjsRenderModule;
  /** Extra `getDocument` options, such as `standardFontDataUrl` and `cMapUrl`. */
  documentOptions?: Record<string, unknown>;
  /** Font family for labels and values, tried before `sans-serif`. */
  labelFont?: string;
}

const rgb = ([r, g, b]: readonly [number, number, number], alpha = 1): string =>
  alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;

const RULER_BACKGROUND = 'rgb(244, 245, 247)';
const RULER_INK = 'rgb(60, 64, 72)';

/** Grid over the page and ruler ticks along the top and left edges, labelled in points. */
function drawGridAndRulers(ctx: Context2d, pageWidth: number, pageHeight: number, scale: number, family: string): void {
  const widthPx = pageWidth * scale;
  const heightPx = pageHeight * scale;
  ctx.fillStyle = RULER_BACKGROUND;
  ctx.fillRect(0, 0, RULER_LEFT + widthPx, RULER_TOP);
  ctx.fillRect(0, 0, RULER_LEFT, RULER_TOP + heightPx);

  // Label every 50 points when there is room for the numbers, else every 100.
  const labelStep = scale >= 1 ? 50 : 100;
  ctx.font = `10px ${family}`;
  ctx.lineWidth = 1;

  const line = (x0: number, y0: number, x1: number, y1: number, style: string) => {
    ctx.strokeStyle = style;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  const gridStyle = (pt: number) => (pt % 100 === 0 ? 'rgba(0, 110, 200, 0.30)' : 'rgba(0, 110, 200, 0.14)');
  const tick = (pt: number) => (pt % 50 === 0 ? 9 : 4);

  for (let pt = 0; pt <= pageWidth; pt += 10) {
    const x = Math.round(RULER_LEFT + pt * scale) + 0.5;
    line(x, RULER_TOP - tick(pt), x, RULER_TOP, RULER_INK);
    if (pt % 50 === 0 && pt > 0) line(x, RULER_TOP, x, RULER_TOP + heightPx, gridStyle(pt));
    if (pt % labelStep === 0) {
      ctx.fillStyle = RULER_INK;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(String(pt), x + 2, 2);
    }
  }
  for (let pt = 0; pt <= pageHeight; pt += 10) {
    const y = Math.round(RULER_TOP + pt * scale) + 0.5;
    line(RULER_LEFT - tick(pt), y, RULER_LEFT, y, RULER_INK);
    if (pt % 50 === 0 && pt > 0) line(RULER_LEFT, y, RULER_LEFT + widthPx, y, gridStyle(pt));
    if (pt % labelStep === 0) {
      ctx.fillStyle = RULER_INK;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'right';
      ctx.fillText(String(pt), RULER_LEFT - 11, pt === 0 ? y + 1 : y + 2);
    }
  }
  ctx.textAlign = 'left';
  ctx.strokeStyle = RULER_INK;
  ctx.strokeRect(RULER_LEFT - 0.5, RULER_TOP - 0.5, widthPx + 1, heightPx + 1);
}

function valuePreview(field: Field): string | undefined {
  if (field.type === 'text' || field.type === 'date') return field.value;
  return undefined;
}

function drawField(ctx: Context2d, family: string, field: Field, rect: Rect, scale: number, canvasWidth: number, canvasHeight: number): void {
  const color = FIELD_COLORS[field.type];
  const x = RULER_LEFT + rect.x * scale;
  const y = RULER_TOP + rect.y * scale;
  const w = rect.width * scale;
  const h = rect.height * scale;

  ctx.fillStyle = rgb(color, 0.14);
  ctx.fillRect(x, y, w, h);

  // An approximate rendering of a prefilled value; the signed PDF may wrap or size it differently.
  const value = valuePreview(field);
  if (value !== undefined && value !== '') {
    const requested = 'fontSize' in field ? field.fontSize : undefined;
    const size = Math.max(4, Math.min(requested ?? 12, rect.height * 0.8)) * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.font = `${size}px ${family}`;
    ctx.fillStyle = 'rgb(20, 20, 20)';
    ctx.textBaseline = 'middle';
    ctx.fillText(value.replace(/\s+/g, ' '), x + 2 * scale, y + h / 2);
    ctx.restore();
  } else if (field.type === 'checkbox' && field.value === true) {
    ctx.strokeStyle = 'rgb(20, 20, 20)';
    ctx.lineWidth = Math.max(1.5, scale);
    ctx.beginPath();
    ctx.moveTo(x + w * 0.2, y + h * 0.2);
    ctx.lineTo(x + w * 0.8, y + h * 0.8);
    ctx.moveTo(x + w * 0.8, y + h * 0.2);
    ctx.lineTo(x + w * 0.2, y + h * 0.8);
    ctx.stroke();
  }

  // White halo under a solid colour outline: visible on dark and light page content alike.
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgb(255, 255, 255)';
  ctx.lineWidth = 4;
  ctx.strokeRect(x, y, w, h);
  ctx.strokeStyle = rgb(color);
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  drawTag(ctx, family, `${field.id} (${field.type}, ${field.assignee})`, color, { x, y, w, h }, 'above', canvasWidth, canvasHeight);
}

/** A dashed outline round one place an ambiguous anchor matched, tagged "<field id> #n" below it. */
function drawCandidate(
  ctx: Context2d,
  family: string,
  field: Field,
  occurrence: number,
  rect: Rect,
  scale: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const color = FIELD_COLORS[field.type];
  const box = { x: RULER_LEFT + rect.x * scale - 2, y: RULER_TOP + rect.y * scale - 2, w: rect.width * scale + 4, h: rect.height * scale + 4 };
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgb(255, 255, 255)';
  ctx.lineWidth = 4;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([5, 3]);
  ctx.strokeStyle = rgb(color);
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([]);
  drawTag(ctx, family, `${field.id} #${occurrence}`, color, box, 'below', canvasWidth, canvasHeight);
}

/**
 * A dotted outline round a placement candidate. Returns a function that draws
 * its "C<n>" tag, right-aligned above the outline: call it after the fields, so
 * no field tag hides it and it does not sit where a field's left-aligned tag goes.
 */
function drawPlacementCandidate(ctx: Context2d, family: string, number: number, rect: Rect, scale: number, canvasWidth: number, canvasHeight: number): () => void {
  const color = PLACEMENT_CANDIDATE_COLOR;
  const box = { x: RULER_LEFT + rect.x * scale - 3, y: RULER_TOP + rect.y * scale - 3, w: rect.width * scale + 6, h: rect.height * scale + 6 };
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgb(255, 255, 255)';
  ctx.lineWidth = 4;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([2, 2]);
  ctx.strokeStyle = rgb(color);
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([]);
  return () => drawTag(ctx, family, `C${number}`, color, box, 'above', canvasWidth, canvasHeight, 'right');
}

/** A filled label next to a box: on the preferred side, or the other side when there is no room. */
function drawTag(
  ctx: Context2d,
  family: string,
  label: string,
  color: readonly [number, number, number],
  box: { x: number; y: number; w: number; h: number },
  side: 'above' | 'below',
  canvasWidth: number,
  canvasHeight: number,
  align: 'left' | 'right' = 'left',
): void {
  ctx.font = `11px ${family}`;
  const tagWidth = Math.ceil(ctx.measureText(label).width) + 8;
  const tagHeight = 15;
  let tagX = Math.max(RULER_LEFT, align === 'left' ? box.x - 1 : box.x + box.w + 1 - tagWidth);
  if (tagX + tagWidth > canvasWidth) tagX = Math.max(RULER_LEFT, canvasWidth - tagWidth);
  const above = box.y - tagHeight - 2;
  const below = box.y + box.h + 2;
  let tagY: number;
  if (side === 'above') tagY = above >= RULER_TOP ? above : Math.min(below, canvasHeight - tagHeight);
  else tagY = below + tagHeight <= canvasHeight ? below : Math.max(RULER_TOP, above);
  ctx.fillStyle = rgb(color);
  ctx.fillRect(tagX, tagY, tagWidth, tagHeight);
  ctx.strokeStyle = 'rgb(255, 255, 255)';
  ctx.lineWidth = 1;
  ctx.strokeRect(tagX - 0.5, tagY - 0.5, tagWidth + 1, tagHeight + 1);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, tagX + 4, tagY + tagHeight / 2 + 0.5);
}

interface PreviewPlan {
  scale: number;
  pages: number[];
  marks: Array<{ field: PreviewLayout['fields'][number]; occurrence: number; rect: Rect }>;
  placements: Array<{ number: number; rect: Rect }>;
}

function planPreview(resolved: PreviewLayout, options: PreviewOptions): PreviewPlan {
  const scale = options.scale ?? DEFAULT_PREVIEW_SCALE;
  if (!Number.isFinite(scale) || scale < MIN_PREVIEW_SCALE || scale > MAX_PREVIEW_SCALE) {
    throw new SignPdfError('invalid-argument', `The scale must be between ${MIN_PREVIEW_SCALE} and ${MAX_PREVIEW_SCALE}.`);
  }
  // Each candidate with the field it belongs to; a candidate for a field that did not resolve is skipped.
  const marks = (options.anchorCandidates ?? []).flatMap(({ fieldId, candidates }) => {
    const field = resolved.fields.find((candidate) => candidate.id === fieldId);
    return field ? candidates.map((rect, index) => ({ field, occurrence: index + 1, rect })) : [];
  });
  const placements = (options.placementCandidates ?? []).map((rect, index) => ({ number: index + 1, rect }));
  const defaultPages = [
    ...resolved.fields.map((field) => field.rect.page),
    ...marks.map((mark) => mark.rect.page),
    ...placements.map((mark) => mark.rect.page),
  ];
  const pages = options.pages ? [...options.pages] : [...new Set(defaultPages)].sort((p, q) => p - q);
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > resolved.pages.length) {
      throw new SignPdfError('invalid-argument', `Page ${page} does not exist: the PDF has ${resolved.pages.length} page(s).`);
    }
  }
  return { scale, pages, marks, placements };
}

/**
 * Check the scale and pages of a preview without rendering it. Throws
 * SignPdfError 'invalid-argument' for a scale out of range or a page the
 * layout does not have, as `renderPreview` would.
 */
export function checkPreviewOptions(resolved: PreviewLayout, options: PreviewOptions = {}): void {
  planPreview(resolved, options);
}

/**
 * Render the chosen pages with every resolved field, and any candidate marks,
 * drawn on them. A bad scale or page, or a page too large to render at the
 * scale, throws SignPdfError 'invalid-argument'.
 */
export async function renderPreview(
  pdf: Uint8Array,
  resolved: PreviewLayout,
  renderer: PreviewRenderer,
  options: PreviewOptions = {},
): Promise<PreviewPage[]> {
  const { scale, pages: wanted, marks, placements } = planPreview(resolved, options);
  const family = renderer.labelFont ? `${renderer.labelFont}, sans-serif` : 'sans-serif';
  const task = renderer.pdfjs.getDocument({
    ...renderer.documentOptions,
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    data: new Uint8Array(pdf),
    verbosity: 0,
    isEvalSupported: false,
  });
  try {
    const doc = await task.promise;
    const out: PreviewPage[] = [];
    for (const pageNumber of wanted) {
      const info = resolved.pages[pageNumber - 1];
      if (!info) continue;
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const pageWidthPx = Math.ceil(info.width * scale);
      const pageHeightPx = Math.ceil(info.height * scale);
      const width = RULER_LEFT + pageWidthPx;
      const height = RULER_TOP + pageHeightPx;
      if (width * height > MAX_PIXELS) {
        throw new SignPdfError('invalid-argument', `Page ${pageNumber} is too large to render at scale ${scale}. Use a smaller scale.`);
      }

      const pageCanvas = renderer.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const pageContext = pageCanvas.getContext('2d');
      pageContext.fillStyle = 'rgb(255, 255, 255)';
      pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      await page.render({ canvas: pageCanvas, canvasContext: pageContext, viewport }).promise;

      const canvas = renderer.createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgb(255, 255, 255)';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(pageCanvas, RULER_LEFT, RULER_TOP);
      drawGridAndRulers(ctx, info.width, info.height, scale, family);
      const fields = resolved.fields.filter((field) => field.rect.page === pageNumber);
      const pageMarks = marks.filter((mark) => mark.rect.page === pageNumber);
      const pagePlacements = placements.filter((mark) => mark.rect.page === pageNumber);
      // Candidates first, so the fields' own boxes and labels stay on top.
      const placementTags = pagePlacements.map((mark) => drawPlacementCandidate(ctx, family, mark.number, mark.rect, scale, width, height));
      for (const mark of pageMarks) drawCandidate(ctx, family, mark.field, mark.occurrence, mark.rect, scale, width, height);
      for (const field of fields) drawField(ctx, family, field, field.rect, scale, width, height);
      for (const drawTagOnTop of placementTags) drawTagOnTop();

      out.push({
        page: pageNumber,
        png: new Uint8Array(await renderer.encodePng(canvas)),
        width,
        height,
        scale,
        origin: { x: RULER_LEFT, y: RULER_TOP },
        pageWidth: info.width,
        pageHeight: info.height,
        fieldIds: fields.map((field) => field.id),
        candidates: pageMarks.map((mark) => ({ fieldId: mark.field.id, occurrence: mark.occurrence })),
        placementCandidates: pagePlacements.map((mark) => mark.number),
      });
    }
    return out;
  } finally {
    await task.destroy();
  }
}
