import { describe, expect, it } from 'vitest';
import type { Rect } from '@sign-pdf/spec';
import {
  clampRect,
  clientToPagePoint,
  defaultRectAt,
  fieldZoom,
  fitWidthZoom,
  growRect,
  keyToAction,
  MIN_FIELD_SIZE,
  moveRect,
  pinchZoom,
  pxToRect,
  rectToPx,
  resizeRect,
  stepZoom,
  ZOOM_MAX,
  ZOOM_MIN,
} from './geometry.ts';

const letter = { width: 612, height: 792 };
const rect: Rect = { page: 2, x: 72, y: 144.5, width: 180, height: 18 };

describe('points and pixels', () => {
  it.each([0.5, 0.75, 1, 1.33, 2, 3.5])('maps a rectangle to pixels and back at zoom %s', (zoom) => {
    const box = rectToPx(rect, zoom);
    expect(box.left).toBeCloseTo(72 * zoom, 6);
    expect(box.top).toBeCloseTo(144.5 * zoom, 6);
    expect(box.width).toBeCloseTo(180 * zoom, 6);
    expect(pxToRect(box, 2, zoom)).toEqual(rect);
  });

  it.each([0.5, 1, 1.5, 2.4])('maps a pointer position to page points at zoom %s', (zoom) => {
    // The page element sits at (100, 250) in the window; the pointer is 72pt right and 36pt down.
    const point = clientToPagePoint(100 + 72 * zoom, 250 + 36 * zoom, { left: 100, top: 250 }, 3, zoom);
    expect(point).toEqual({ page: 3, x: 72, y: 36 });
  });

  it('uses a top-left origin with y growing downward', () => {
    const top = clientToPagePoint(0, 10, { left: 0, top: 0 }, 1, 1);
    const lower = clientToPagePoint(0, 400, { left: 0, top: 0 }, 1, 1);
    expect(lower.y).toBeGreaterThan(top.y);
  });

  it('keeps points to two decimals', () => {
    expect(clientToPagePoint(100, 100, { left: 0, top: 0 }, 1, 3).x).toBe(33.33);
  });
});

describe('moving and resizing', () => {
  it('moves by a delta in points', () => {
    expect(moveRect(rect, 10, -4.5, letter)).toEqual({ ...rect, x: 82, y: 140 });
  });

  it('keeps a moved field on its page', () => {
    expect(moveRect(rect, -500, -500, letter)).toMatchObject({ x: 0, y: 0 });
    expect(moveRect(rect, 5000, 5000, letter)).toMatchObject({ x: 612 - 180, y: 792 - 18 });
  });

  it('shrinks a field that is larger than the page', () => {
    expect(clampRect({ page: 1, x: -5, y: 0, width: 900, height: 20 }, letter)).toEqual({
      page: 1,
      x: 0,
      y: 0,
      width: 612,
      height: 20,
    });
  });

  it('resizes from the bottom-right corner, leaving the top-left in place', () => {
    expect(resizeRect(rect, 'se', 20, 6, letter)).toEqual({ ...rect, width: 200, height: 24 });
  });

  it('resizes from the top-left corner, leaving the bottom-right in place', () => {
    const next = resizeRect(rect, 'nw', 10, 4, letter);
    expect(next).toEqual({ page: 2, x: 82, y: 148.5, width: 170, height: 14 });
    expect(next.x + next.width).toBe(rect.x + rect.width);
    expect(next.y + next.height).toBe(rect.y + rect.height);
  });

  it('never makes a field smaller than the minimum or larger than the page', () => {
    expect(resizeRect(rect, 'se', -1000, -1000, letter)).toMatchObject({
      width: MIN_FIELD_SIZE,
      height: MIN_FIELD_SIZE,
    });
    const grown = growRect(rect, 5000, 5000, letter);
    expect(grown.x + grown.width).toBe(612);
    expect(grown.y + grown.height).toBe(792);
  });

  it('places a new field at the clicked point, inside the page', () => {
    expect(defaultRectAt('signature', { page: 1, x: 100, y: 200 }, letter)).toEqual({
      page: 1,
      x: 100,
      y: 200,
      width: 180,
      height: 44,
    });
    expect(defaultRectAt('signature', { page: 1, x: 600, y: 790 }, letter)).toMatchObject({
      x: 612 - 180,
      y: 792 - 44,
    });
  });
});

describe('keyboard contract', () => {
  const key = (name: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean }> = {}) =>
    keyToAction({ key: name, shiftKey: false, altKey: false, ...mods });

  it('nudges 1pt with arrows and 10pt with Shift', () => {
    expect(key('ArrowLeft')).toEqual({ kind: 'move', dx: -1, dy: 0 });
    expect(key('ArrowDown')).toEqual({ kind: 'move', dx: 0, dy: 1 });
    expect(key('ArrowUp', { shiftKey: true })).toEqual({ kind: 'move', dx: 0, dy: -10 });
  });

  it('resizes with Alt', () => {
    expect(key('ArrowRight', { altKey: true })).toEqual({ kind: 'resize', dw: 1, dh: 0 });
    expect(key('ArrowUp', { altKey: true, shiftKey: true })).toEqual({ kind: 'resize', dw: 0, dh: -10 });
  });

  it('removes with Delete or Backspace, and ignores other keys and shortcuts', () => {
    expect(key('Delete')).toEqual({ kind: 'delete' });
    expect(key('Backspace')).toEqual({ kind: 'delete' });
    expect(key('a')).toBeNull();
    expect(key('ArrowLeft', { ctrlKey: true })).toBeNull();
  });
});

describe('zoom', () => {
  it('steps within limits', () => {
    expect(stepZoom(1, 1)).toBe(1.2);
    expect(stepZoom(1.2, -1)).toBe(1);
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });

  it('fits a page to the available width', () => {
    expect(fitWidthZoom(612, 306)).toBe(0.5);
    expect(fitWidthZoom(612, 343)).toBe(0.56);
    expect(fitWidthZoom(612, 0)).toBe(1);
  });
});

describe('zoom for guided signing', () => {
  it('zooms in on a field on a narrow screen, never out, and leaves a wide screen alone', () => {
    // A phone: 358 px for a 612 pt page fits at 0.58; a short field is shown at 1.1.
    expect(fieldZoom(0.58, 100, 358)).toBe(1.1);
    // A wide field is zoomed only as far as it fits, with a margin.
    expect(fieldZoom(0.58, 400, 358)).toBe(0.81);
    // Already closer than that: kept.
    expect(fieldZoom(1.6, 100, 358)).toBe(1.6);
    expect(fieldZoom(0.9, 100, 1000)).toBe(0.9);
    expect(fieldZoom(0.58, 0, 358)).toBe(0.58);
  });

  it('follows the spread of two fingers within the zoom limits', () => {
    expect(pinchZoom(1, 100, 150)).toBe(1.5);
    expect(pinchZoom(1, 100, 50)).toBe(0.5);
    expect(pinchZoom(1, 100, 10)).toBe(0.4);
    expect(pinchZoom(2, 100, 1000)).toBe(4);
    expect(pinchZoom(1.2, 0, 100)).toBe(1.2);
  });
});
