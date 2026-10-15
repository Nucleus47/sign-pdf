/**
 * Mapping between spec coordinates and the screen.
 *
 * The spec uses PDF points with the origin at the top-left of the page as
 * displayed, y down. A pdf.js viewport at scale `s` draws that same displayed
 * page at `s` CSS pixels per point, so the mapping is one multiplication.
 * Everything that touches pixels goes through this file.
 */
import type { FieldType, PageInfo, Rect } from '@sign-pdf/spec';

export interface PxBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PagePoint {
  page: number;
  x: number;
  y: number;
}

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

/** Smallest field edge the editor allows, in points. */
export const MIN_FIELD_SIZE = 6;

/** Points are kept to 2 decimals: finer than any printer, and stable in JSON. */
export function roundPt(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

export function ptToPx(pt: number, scale: number): number {
  return pt * scale;
}

export function pxToPt(px: number, scale: number): number {
  return roundPt(px / scale);
}

export function rectToPx(rect: Rect, scale: number): PxBox {
  return {
    left: rect.x * scale,
    top: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

export function pxToRect(box: PxBox, page: number, scale: number): Rect {
  return {
    page,
    x: pxToPt(box.left, scale),
    y: pxToPt(box.top, scale),
    width: pxToPt(box.width, scale),
    height: pxToPt(box.height, scale),
  };
}

/** A pointer position relative to the page element's top-left, to spec points. */
export function clientToPagePoint(
  clientX: number,
  clientY: number,
  pageBox: { left: number; top: number },
  page: number,
  scale: number,
): PagePoint {
  return {
    page,
    x: pxToPt(clientX - pageBox.left, scale),
    y: pxToPt(clientY - pageBox.top, scale),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Keep a rectangle inside its page, shrinking it only when it cannot fit. */
export function clampRect(rect: Rect, page: Pick<PageInfo, 'width' | 'height'>): Rect {
  const width = clamp(rect.width, MIN_FIELD_SIZE, page.width);
  const height = clamp(rect.height, MIN_FIELD_SIZE, page.height);
  return {
    page: rect.page,
    x: roundPt(clamp(rect.x, 0, page.width - width)),
    y: roundPt(clamp(rect.y, 0, page.height - height)),
    width: roundPt(width),
    height: roundPt(height),
  };
}

export function moveRect(
  rect: Rect,
  dxPt: number,
  dyPt: number,
  page: Pick<PageInfo, 'width' | 'height'>,
): Rect {
  return clampRect({ ...rect, x: rect.x + dxPt, y: rect.y + dyPt }, page);
}

/** Drag one corner by a delta in points; the opposite corner stays put. */
export function resizeRect(
  rect: Rect,
  handle: ResizeHandle,
  dxPt: number,
  dyPt: number,
  page: Pick<PageInfo, 'width' | 'height'>,
): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle === 'nw' || handle === 'sw') {
    left = clamp(left + dxPt, 0, right - MIN_FIELD_SIZE);
  } else {
    right = clamp(right + dxPt, left + MIN_FIELD_SIZE, page.width);
  }
  if (handle === 'nw' || handle === 'ne') {
    top = clamp(top + dyPt, 0, bottom - MIN_FIELD_SIZE);
  } else {
    bottom = clamp(bottom + dyPt, top + MIN_FIELD_SIZE, page.height);
  }
  return {
    page: rect.page,
    x: roundPt(left),
    y: roundPt(top),
    width: roundPt(right - left),
    height: roundPt(bottom - top),
  };
}

/** Grow or shrink from the bottom-right corner (keyboard resize). */
export function growRect(
  rect: Rect,
  dwPt: number,
  dhPt: number,
  page: Pick<PageInfo, 'width' | 'height'>,
): Rect {
  return resizeRect(rect, 'se', dwPt, dhPt, page);
}

export type KeyAction =
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'resize'; dw: number; dh: number }
  | { kind: 'delete' }
  | null;

/** The keyboard contract for a focused field box. */
export function keyToAction(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): KeyAction {
  if (event.ctrlKey || event.metaKey) return null;
  if (event.key === 'Delete' || event.key === 'Backspace') return { kind: 'delete' };
  const step = event.shiftKey ? 10 : 1;
  const direction: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const vector = direction[event.key];
  if (!vector) return null;
  const [ux, uy] = vector;
  if (event.altKey) return { kind: 'resize', dw: ux * step, dh: uy * step };
  return { kind: 'move', dx: ux * step, dy: uy * step };
}

/** Default field sizes in points, chosen to sit on a typical form line. */
export const DEFAULT_FIELD_SIZE: Record<FieldType, { width: number; height: number }> = {
  text: { width: 180, height: 18 },
  date: { width: 90, height: 18 },
  checkbox: { width: 14, height: 14 },
  signature: { width: 180, height: 44 },
  initials: { width: 64, height: 32 },
};

/** A new field of `type` whose top-left corner is at the clicked point. */
export function defaultRectAt(
  type: FieldType,
  point: PagePoint,
  page: Pick<PageInfo, 'width' | 'height'>,
): Rect {
  const size = DEFAULT_FIELD_SIZE[type];
  return clampRect({ page: point.page, x: point.x, y: point.y, ...size }, page);
}

/** Zoom steps offered by the viewer. */
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 4;

export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = direction === 1 ? zoom * 1.2 : zoom / 1.2;
  return Math.round(clamp(next, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
}

/** The zoom at which a page of `pageWidthPt` fills `availablePx`. */
export function fitWidthZoom(pageWidthPt: number, availablePx: number): number {
  if (!(pageWidthPt > 0) || !(availablePx > 0)) return 1;
  return Math.round(clamp(availablePx / pageWidthPt, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
}

/** Below this many CSS pixels of width the viewer zooms in on the field being filled. */
export const FIELD_ZOOM_BELOW_PX = 720;
/** The zoom a field is shown at on a narrow screen: body text near 13 px. */
export const FIELD_ZOOM_TARGET = 1.1;

/**
 * The zoom for showing a field on a narrow screen: large enough to read the
 * text around it, small enough that the whole field (plus a margin) fits the
 * width, and never smaller than the current zoom. On a wide screen it is the
 * current zoom: there the page is already legible.
 */
export function fieldZoom(current: number, fieldWidthPt: number, availablePx: number): number {
  if (!(availablePx > 0) || availablePx >= FIELD_ZOOM_BELOW_PX || !(fieldWidthPt > 0)) return current;
  const wanted = Math.min(FIELD_ZOOM_TARGET, (availablePx * 0.9) / fieldWidthPt);
  return Math.round(clamp(Math.max(current, wanted), ZOOM_MIN, ZOOM_MAX) * 100) / 100;
}

/** The zoom during a two-finger pinch: the start zoom scaled by how far the fingers spread. */
export function pinchZoom(startZoom: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return startZoom;
  return Math.round(clamp((startZoom * distance) / startDistance, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
}
