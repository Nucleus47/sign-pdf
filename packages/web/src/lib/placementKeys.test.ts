import { describe, expect, it } from 'vitest';
import type { Rect } from '@sign-pdf/spec';
import {
  cycleField,
  ghostStartRect,
  isTextEntryTarget,
  PREPARE_SHORTCUTS,
  REGION_KEYSHORTCUTS,
  readingOrder,
  regionKeyToCommand,
  retypeGhost,
  type KeyEventLike,
} from './placementKeys.ts';

const press = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

const page = { page: 1, width: 612, height: 792 };

describe('numbered place keys', () => {
  it('maps M to the marker toggle and 1-9 to a jump, with or without a placement box', () => {
    expect(regionKeyToCommand(press('m'), false)).toEqual({ kind: 'markers' });
    expect(regionKeyToCommand(press('M', { shiftKey: true }), true)).toEqual({ kind: 'markers' });
    for (const ghost of [false, true]) {
      expect(regionKeyToCommand(press('1'), ghost)).toEqual({ kind: 'jump', number: 1 });
      expect(regionKeyToCommand(press('9'), ghost)).toEqual({ kind: 'jump', number: 9 });
    }
  });

  it('ignores 0, chords and keys typed with modifiers', () => {
    expect(regionKeyToCommand(press('0'), false)).toBeNull();
    expect(regionKeyToCommand(press('3', { ctrlKey: true }), false)).toBeNull();
    expect(regionKeyToCommand(press('3', { metaKey: true }), true)).toBeNull();
    expect(regionKeyToCommand(press('3', { altKey: true }), false)).toBeNull();
    expect(regionKeyToCommand(press('m', { ctrlKey: true }), false)).toBeNull();
  });

  it('falls back to the top-row key code when the typed character is not a digit (AZERTY)', () => {
    const azerty = (key: string, code: string, mods: Partial<KeyEventLike> = {}) => press(key, { code, ...mods });
    expect(regionKeyToCommand(azerty('&', 'Digit1'), false)).toEqual({ kind: 'jump', number: 1 });
    expect(regionKeyToCommand(azerty('é', 'Digit2'), true)).toEqual({ kind: 'jump', number: 2 });
    expect(regionKeyToCommand(azerty('ç', 'Digit9'), false)).toEqual({ kind: 'jump', number: 9 });
    expect(regionKeyToCommand(azerty('Dead', 'Digit2'), false)).toEqual({ kind: 'jump', number: 2 });
    // Shift+top row types the digit on AZERTY; the character decides.
    expect(regionKeyToCommand(azerty('3', 'Digit3', { shiftKey: true }), false)).toEqual({ kind: 'jump', number: 3 });
    // The numpad sends the digit as the character.
    expect(regionKeyToCommand(azerty('4', 'Numpad4'), false)).toEqual({ kind: 'jump', number: 4 });
  });

  it('does not let the key code fallback override other keys', () => {
    const coded = (key: string, code: string, mods: Partial<KeyEventLike> = {}) => press(key, { code, ...mods });
    expect(regionKeyToCommand(coded('à', 'Digit0'), false)).toBeNull();
    expect(regionKeyToCommand(coded('0', 'Digit0', { shiftKey: true }), false)).toBeNull();
    // Shift+1 on a US layout types "!": not a jump.
    expect(regionKeyToCommand(coded('!', 'Digit1', { shiftKey: true }), false)).toBeNull();
    expect(regionKeyToCommand(coded('&', 'Digit1', { ctrlKey: true }), false)).toBeNull();
    expect(regionKeyToCommand(coded('&', 'Digit1', { metaKey: true }), false)).toBeNull();
    expect(regionKeyToCommand(coded('~', 'Digit2', { altKey: true }), false)).toBeNull();
    expect(regionKeyToCommand(coded('End', 'Numpad1'), false)).toBeNull();
    // A command character wins over the physical key it sits on.
    expect(regionKeyToCommand(coded('s', 'Digit3'), false)).toEqual({ kind: 'start', type: 'signature' });
    expect(regionKeyToCommand(coded('?', 'Digit7', { shiftKey: true }), false)).toEqual({ kind: 'help' });
  });

  it('lists M and the digits in the help table and the region key shortcuts', () => {
    expect(PREPARE_SHORTCUTS.some((row) => row.keys.includes('M'))).toBe(true);
    expect(PREPARE_SHORTCUTS.some((row) => row.keys.includes('1-9'))).toBe(true);
    expect(REGION_KEYSHORTCUTS.split(' ')).toEqual(expect.arrayContaining(['M', '1', '9']));
  });
});

describe('page region keys', () => {
  it('starts a placement for each type letter, either case', () => {
    expect(regionKeyToCommand(press('t'), false)).toEqual({ kind: 'start', type: 'text' });
    expect(regionKeyToCommand(press('D', { shiftKey: true }), false)).toEqual({ kind: 'start', type: 'date' });
    expect(regionKeyToCommand(press('c'), false)).toEqual({ kind: 'start', type: 'checkbox' });
    expect(regionKeyToCommand(press('s'), false)).toEqual({ kind: 'start', type: 'signature' });
    expect(regionKeyToCommand(press('i'), true)).toEqual({ kind: 'start', type: 'initials' });
  });

  it('maps help, field cycling and the assignee toggle', () => {
    expect(regionKeyToCommand(press('?', { shiftKey: true }), false)).toEqual({ kind: 'help' });
    expect(regionKeyToCommand(press(']'), false)).toEqual({ kind: 'next' });
    expect(regionKeyToCommand(press('['), false)).toEqual({ kind: 'previous' });
    expect(regionKeyToCommand(press('a'), false)).toEqual({ kind: 'assignee' });
  });

  it('moves, resizes, commits and cancels only while a ghost box shows', () => {
    expect(regionKeyToCommand(press('ArrowLeft'), true)).toEqual({ kind: 'move', dx: -1, dy: 0 });
    expect(regionKeyToCommand(press('ArrowDown', { shiftKey: true }), true)).toEqual({ kind: 'move', dx: 0, dy: 10 });
    expect(regionKeyToCommand(press('ArrowRight', { altKey: true }), true)).toEqual({ kind: 'resize', dw: 1, dh: 0 });
    expect(regionKeyToCommand(press('Enter'), true)).toEqual({ kind: 'commit' });
    expect(regionKeyToCommand(press('Escape'), true)).toEqual({ kind: 'cancel' });
    for (const key of ['ArrowLeft', 'Enter', 'Escape']) expect(regionKeyToCommand(press(key), false)).toBeNull();
    expect(regionKeyToCommand(press('Delete'), true)).toBeNull();
  });

  it('leaves browser and modified keys alone', () => {
    expect(regionKeyToCommand(press('t', { ctrlKey: true }), false)).toBeNull();
    expect(regionKeyToCommand(press('d', { metaKey: true }), false)).toBeNull();
    expect(regionKeyToCommand(press('t', { altKey: true }), false)).toBeNull();
    expect(regionKeyToCommand(press('z'), false)).toBeNull();
    expect(regionKeyToCommand(press('PageDown'), false)).toBeNull();
  });
});

describe('text entry targets', () => {
  it('treats inputs, text areas, selects and editable content as text entry', () => {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not compute isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    for (const element of [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      editable,
    ]) {
      expect(isTextEntryTarget(element)).toBe(true);
    }
    expect(isTextEntryTarget(document.createElement('div'))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

describe('ghost box position', () => {
  it('starts in the page centre with the type default size', () => {
    expect(ghostStartRect('text', page, null)).toEqual({ page: 1, x: 216, y: 387, width: 180, height: 18 });
  });

  it('starts just below the selected field on the same page, kept on the page', () => {
    const near: Rect = { page: 1, x: 72, y: 100, width: 180, height: 18 };
    expect(ghostStartRect('date', page, near)).toMatchObject({ x: 72, y: 126, width: 90 });
    const bottom: Rect = { page: 1, x: 72, y: 780, width: 180, height: 12 };
    expect(ghostStartRect('signature', page, bottom).y).toBe(792 - 44);
    expect(ghostStartRect('text', { ...page, page: 2 }, near)).toMatchObject({ page: 2, x: 216 });
  });

  it('keeps its corner when the type changes', () => {
    const rect: Rect = { page: 1, x: 40, y: 50, width: 180, height: 18 };
    expect(retypeGhost(rect, 'checkbox', page)).toEqual({ page: 1, x: 40, y: 50, width: 14, height: 14 });
  });
});

describe('field cycling', () => {
  const fields = [
    { id: 'b', rect: { page: 1, x: 300, y: 100, width: 10, height: 10 } },
    { id: 'c', rect: { page: 2, x: 0, y: 0, width: 10, height: 10 } },
    { id: 'a', rect: { page: 1, x: 72, y: 100, width: 10, height: 10 } },
    { id: 'top', rect: { page: 1, x: 500, y: 20, width: 10, height: 10 } },
  ];

  it('orders by page, then top to bottom, then left to right', () => {
    expect(readingOrder(fields).map((field) => field.id)).toEqual(['top', 'a', 'b', 'c']);
  });

  it('walks forward and back and wraps around', () => {
    expect(cycleField(fields, null, 1)).toBe('top');
    expect(cycleField(fields, null, -1)).toBe('c');
    expect(cycleField(fields, 'a', 1)).toBe('b');
    expect(cycleField(fields, 'c', 1)).toBe('top');
    expect(cycleField(fields, 'top', -1)).toBe('c');
    expect(cycleField([], null, 1)).toBeNull();
  });
});
