/**
 * Text extraction through pdf.js. pdf-lib cannot extract text.
 *
 * The core never configures a pdf.js worker. In Node it loads the legacy build
 * on first use, which runs without a worker and without a canvas. A browser app
 * passes its own, already configured pdf.js module to `configurePdfjs`, so the
 * page and the core share one copy and one worker.
 */
import { SignPdfError, errorMessage } from './errors.ts';
import type { Rect } from '@sign-pdf/spec';
import { displayBounds, type Matrix, type PageGeometry } from './geometry.ts';
import type { TextItem } from './index.ts';

interface PdfjsTextEntry {
  str?: string;
  /** Text matrix [a b c d e f] in PDF-native user space. */
  transform?: number[];
  width?: number;
  height?: number;
}

interface PdfjsPage {
  /** Items are text runs or marked-content markers; only runs carry `str`. */
  getTextContent(): Promise<{ items: readonly object[] }>;
  getOperatorList?(params?: { annotationMode?: number }): Promise<{ fnArray: readonly number[]; argsArray: readonly unknown[] }>;
}

interface PdfjsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
}

/** The part of the pdf.js module the core uses. `import * as pdfjs from 'pdfjs-dist'` satisfies it. */
export interface PdfjsLike {
  /** Operator codes; needed only to find drawn lines. */
  OPS?: Record<string, number>;
  getDocument(source: { data: Uint8Array; [option: string]: unknown }): {
    promise: Promise<PdfjsDocument>;
    destroy(): Promise<void>;
  };
}

let configured: PdfjsLike | undefined;
let fallback: Promise<PdfjsLike> | undefined;

/**
 * Give the core the pdf.js module to use for text extraction. Browser apps must
 * call this once, after setting `GlobalWorkerOptions.workerSrc` (or `workerPort`)
 * on that module. Node callers need not call it. Pass `undefined` to reset.
 */
export function configurePdfjs(pdfjs: PdfjsLike | undefined): void {
  configured = pdfjs;
}

function getPdfjs(): Promise<PdfjsLike> {
  if (configured) return Promise.resolve(configured);
  const loading = fallback ?? import('pdfjs-dist/legacy/build/pdf.mjs');
  fallback = loading;
  return loading;
}

/** Text runs for every page, in the spec's coordinate system. */
export async function extractText(pdf: Uint8Array, pages: readonly PageGeometry[]): Promise<TextItem[]> {
  return (await extractPageContent(pdf, pages, { rules: false })).text;
}

export interface PageContent {
  text: TextItem[];
  /** Horizontal lines drawn on the pages (not typed underscores), as thin rects. */
  rules: Rect[];
}

/** Text runs and, when asked, drawn horizontal lines for every page, in the spec's coordinate system. */
export async function extractPageContent(
  pdf: Uint8Array,
  pages: readonly PageGeometry[],
  options: { rules: boolean },
): Promise<PageContent> {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    data: new Uint8Array(pdf),
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
  });
  try {
    const doc = await task.promise;
    const text: TextItem[] = [];
    const rules: Rect[] = [];
    for (const geometry of pages) {
      if (geometry.page > doc.numPages) break;
      const page = await doc.getPage(geometry.page);
      const content = await page.getTextContent();
      for (const entry of content.items) {
        const item = toTextItem(entry, geometry);
        if (item) text.push(item);
      }
      if (options.rules && pdfjs.OPS && page.getOperatorList) // Annotations are left out: their appearance streams carry their own transforms, and form fields are listed apart.
        rules.push(...drawnRules(await page.getOperatorList({ annotationMode: ANNOTATION_MODE_DISABLE }), pdfjs.OPS, geometry));
    }
    return { text, rules };
  } catch (error) {
    if (error instanceof SignPdfError) throw error;
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new SignPdfError('encrypted-pdf', 'The PDF is encrypted. Remove the password protection first.');
    }
    throw new SignPdfError('invalid-pdf', `pdf.js could not read the PDF's text: ${errorMessage(error)}`);
  } finally {
    await task.destroy();
  }
}

/** pdf.js AnnotationMode.DISABLE. */
const ANNOTATION_MODE_DISABLE = 0;
/** A drawn line shorter than this, in points, is not a blank to write on. */
const MIN_RULE_WIDTH = 18;
/** A filled rect at most this tall, in points, is a line. */
const MAX_RULE_THICKNESS = 3;
/** pdf.js path codes in a constructPath's path data (DrawOPS). */
const MOVE_TO = 0;
const LINE_TO = 1;
const CURVE_TO = 2;
const QUADRATIC_CURVE_TO = 3;
const CLOSE_PATH = 4;
const POINTS_PER_CODE: Record<number, number> = { [MOVE_TO]: 1, [LINE_TO]: 1, [CURVE_TO]: 3, [QUADRATIC_CURVE_TO]: 2, [CLOSE_PATH]: 0 };

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const isMatrix = (value: unknown): value is Matrix =>
  Array.isArray(value) || ArrayBuffer.isView(value)
    ? (value as ArrayLike<unknown>).length >= 6 && Array.from(value as ArrayLike<unknown>).slice(0, 6).every((n) => typeof n === 'number' && Number.isFinite(n))
    : false;

/**
 * Horizontal lines on a page: stroked horizontal segments (including the edges
 * of stroked boxes) and thin filled rects, as the page displays them. Curves
 * and short marks are skipped. Identical lines are listed once.
 */
function drawnRules(
  list: { fnArray: readonly number[]; argsArray: readonly unknown[] },
  OPS: Record<string, number>,
  geometry: PageGeometry,
): Rect[] {
  const strokes = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const found = new Map<string, Rect>();
  const add = (points: ReadonlyArray<readonly [number, number]>, thin: boolean): void => {
    const rect = displayBounds(geometry, points);
    if (rect.width < MIN_RULE_WIDTH || rect.height > (thin ? MAX_RULE_THICKNESS : 0.5)) return;
    const key = [rect.x, rect.y, rect.width, rect.height].map((n) => n.toFixed(1)).join();
    if (!found.has(key)) found.set(key, rect);
  };
  list.fnArray.forEach((fn, index) => {
    const args = list.argsArray[index];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = Array.isArray(args) ? args[0] : undefined;
      if (fn === OPS.paintFormXObjectBegin && isMatrix(matrix)) ctm = multiply(ctm, Array.from(matrix).slice(0, 6) as Matrix);
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform && isMatrix(args)) {
      ctm = multiply(ctm, Array.from(args).slice(0, 6) as Matrix);
    } else if (fn === OPS.constructPath && Array.isArray(args)) {
      const [paint, data] = args as [unknown, unknown];
      const path = Array.isArray(data) ? data[0] : undefined;
      if (typeof paint !== 'number' || !(ArrayBuffer.isView(path) || Array.isArray(path))) return;
      const stroked = strokes.has(paint);
      const filled = fills.has(paint);
      if (!stroked && !filled) return;
      for (const shape of subpaths(path as ArrayLike<number>)) {
        const points = shape.points.map(([x, y]) => apply(ctm, x, y));
        if (stroked) {
          const edges = shape.closed ? points.length : points.length - 1;
          for (let i = 0; i < edges; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            if (a && b && !shape.curved[i]) add([a, b], false);
          }
        }
        if (filled && shape.points.length >= 3 && !shape.curved.some(Boolean)) add(points, true);
      }
    }
  });
  return [...found.values()];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

interface Subpath {
  points: Array<[number, number]>;
  /** curved[i]: the edge from point i to point i + 1 is a curve. */
  curved: boolean[];
  closed: boolean;
}

/** Split pdf.js path data into subpaths of straight and curved edges. */
function subpaths(path: ArrayLike<number>): Subpath[] {
  const shapes: Subpath[] = [];
  let current: Subpath | undefined;
  for (let i = 0; i < path.length; ) {
    const code = path[i++] ?? -1;
    const count = POINTS_PER_CODE[code];
    if (count === undefined) break; // Unknown data: stop rather than misread it.
    const coords: Array<[number, number]> = [];
    for (let k = 0; k < count; k++, i += 2) coords.push([path[i] ?? 0, path[i + 1] ?? 0]);
    const end = coords[coords.length - 1];
    if (code === MOVE_TO && end) {
      current = { points: [end], curved: [], closed: false };
      shapes.push(current);
    } else if (code === CLOSE_PATH) {
      if (current) current.closed = true;
      current = undefined;
    } else if (current && end) {
      current.curved.push(code !== LINE_TO);
      current.points.push(end);
    }
  }
  return shapes;
}

/**
 * The run's box spans from its baseline up by the font size and along the
 * baseline by the run's width; descenders fall just below it.
 */
function toTextItem(entry: object, geometry: PageGeometry): TextItem | undefined {
  const { str, transform, width, height }: PdfjsTextEntry = entry;
  if (typeof str !== 'string' || str.trim() === '' || !transform || transform.length < 6) return undefined;
  if (!width || !height || !(width > 0) || !(height > 0)) return undefined;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = transform;
  const alongLength = Math.hypot(a, b);
  const upLength = Math.hypot(c, d);
  if (alongLength === 0 || upLength === 0) return undefined;
  const ax = (a / alongLength) * width;
  const ay = (b / alongLength) * width;
  const ux = (c / upLength) * height;
  const uy = (d / upLength) * height;
  const rect = displayBounds(geometry, [
    [e, f],
    [e + ax, f + ay],
    [e + ux, f + uy],
    [e + ax + ux, f + ay + uy],
  ]);
  if (!(rect.width > 0 && rect.height > 0)) return undefined;
  return { ...rect, text: str };
}
