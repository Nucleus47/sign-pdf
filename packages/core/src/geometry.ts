/**
 * Conversion between the spec's coordinate system (points, origin at the
 * top-left of the page as displayed, y down) and PDF-native user space
 * (origin and orientation set by the page's boxes and /Rotate).
 */
import { PDFName, PDFNumber, type PDFPage } from '@cantoo/pdf-lib';
import type { PageInfo, Rect } from '@sign-pdf/spec';

export interface PageGeometry extends PageInfo {
  /** Visible box in PDF-native user space: the crop box clipped to the media box. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Clockwise rotation applied for display. */
  rotation: 0 | 90 | 180 | 270;
  /** /UserUnit: how many points one unit of PDF-native user space measures. Usually 1. */
  unit: number;
}

/** Affine matrix [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = [number, number, number, number, number, number];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function corners(box: Box): [number, number, number, number] {
  const xa = box.x;
  const xb = box.x + box.width;
  const ya = box.y;
  const yb = box.y + box.height;
  return [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
}

function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(angle) % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

export function pageGeometry(page: PDFPage, pageNumber: number): PageGeometry {
  const [mx0, my0, mx1, my1] = corners(page.getMediaBox());
  const [cx0, cy0, cx1, cy1] = corners(page.getCropBox());
  let x0 = Math.max(mx0, cx0);
  let y0 = Math.max(my0, cy0);
  let x1 = Math.min(mx1, cx1);
  let y1 = Math.min(my1, cy1);
  // A crop box that misses the media box is ignored, as PDF viewers do.
  if (x1 <= x0 || y1 <= y0) [x0, y0, x1, y1] = [mx0, my0, mx1, my1];
  const rotation = normalizeRotation(page.getRotation().angle);
  const sideways = rotation === 90 || rotation === 270;
  const userUnit = page.node.lookup(PDFName.of('UserUnit'));
  const declared = userUnit instanceof PDFNumber ? userUnit.asNumber() : 1;
  const unit = Number.isFinite(declared) && declared > 0 ? declared : 1;
  return {
    page: pageNumber,
    width: (sideways ? y1 - y0 : x1 - x0) * unit,
    height: (sideways ? x1 - x0 : y1 - y0) * unit,
    x0,
    y0,
    x1,
    y1,
    rotation,
    unit,
  };
}

/** Matrix taking displayed coordinates (top-left origin, y down) to PDF-native user space. */
export function displayToNativeMatrix(g: PageGeometry): Matrix {
  // One displayed point is 1 / unit of a native unit.
  const s = 1 / g.unit;
  switch (g.rotation) {
    case 0:
      return [s, 0, 0, -s, g.x0, g.y1];
    case 90:
      return [0, s, s, 0, g.x0, g.y0];
    case 180:
      return [-s, 0, 0, s, g.x1, g.y0];
    case 270:
      return [0, -s, -s, 0, g.x1, g.y1];
  }
}

/** PDF-native point to displayed coordinates. */
export function nativeToDisplay(g: PageGeometry, x: number, y: number): [number, number] {
  const u = g.unit;
  switch (g.rotation) {
    case 0:
      return [(x - g.x0) * u, (g.y1 - y) * u];
    case 90:
      return [(y - g.y0) * u, (x - g.x0) * u];
    case 180:
      return [(g.x1 - x) * u, (y - g.y0) * u];
    case 270:
      return [(g.y1 - y) * u, (g.x1 - x) * u];
  }
}

/** Bounding box, in displayed coordinates, of points given in PDF-native space. */
export function displayBounds(g: PageGeometry, points: ReadonlyArray<readonly [number, number]>): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of points) {
    const [x, y] = nativeToDisplay(g, px, py);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { page: g.page, x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** A PDF-native rectangle (such as a widget's /Rect) as a displayed Rect. */
export function nativeRectToDisplay(g: PageGeometry, box: Box): Rect {
  return displayBounds(g, [
    [box.x, box.y],
    [box.x + box.width, box.y + box.height],
  ]);
}

/**
 * Matrix for drawing inside a displayed rectangle. In the resulting frame the
 * origin is the rectangle's bottom-left corner as the reader sees it, x runs
 * right and y runs up, whatever the page's rotation or crop box.
 */
export function rectFrameMatrix(g: PageGeometry, rect: Rect): Matrix {
  const [a, b, c, d, e, f] = displayToNativeMatrix(g);
  const bottom = rect.y + rect.height;
  return [a, b, -c, -d, a * rect.x + c * bottom + e, b * rect.x + d * bottom + f];
}

const EPSILON = 0.01;

export function rectWithinPage(rect: Rect, page: PageInfo): boolean {
  return (
    rect.x >= -EPSILON &&
    rect.y >= -EPSILON &&
    rect.x + rect.width <= page.width + EPSILON &&
    rect.y + rect.height <= page.height + EPSILON
  );
}
