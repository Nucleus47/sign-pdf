/**
 * The keyboard contract for the Prepare view's page region: single-key
 * shortcuts that start a placement ("ghost") box, move it, commit it, and
 * walk through fields. Pure functions; the view owns focus and state.
 *
 * Single-character keys act only while the page region or a field box has
 * focus, never in a text entry control (WCAG 2.1.4, "active only on focus").
 */
import type { FieldType, PageInfo, Rect } from '@sign-pdf/spec';
import { clampRect, DEFAULT_FIELD_SIZE, keyToAction, roundPt } from './geometry.ts';

/** The letter that starts placing each field type. */
export const PLACE_KEY: Record<FieldType, string> = {
  text: 'T',
  date: 'D',
  checkbox: 'C',
  signature: 'S',
  initials: 'I',
};

const TYPE_BY_KEY: Record<string, FieldType> = Object.fromEntries(
  Object.entries(PLACE_KEY).map(([type, key]) => [key.toLowerCase(), type as FieldType]),
);

export interface KeyEventLike {
  key: string;
  /** The physical key, e.g. `Digit1`. Optional: only the number fallback reads it. */
  code?: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type RegionCommand =
  | { kind: 'start'; type: FieldType }
  | { kind: 'commit' }
  | { kind: 'cancel' }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'resize'; dw: number; dh: number }
  | { kind: 'help' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'assignee' }
  | { kind: 'markers' }
  /** Go to numbered place `number` (1-9) on the visible page. */
  | { kind: 'jump'; number: number };

/** The key that shows or hides the numbered places. */
export const MARKERS_KEY = 'M';

/**
 * Map a key press in the page region to a command. Arrow keys, Enter and
 * Escape mean something only while a ghost box is showing; elsewhere the
 * focused field box or the browser handles them.
 */
export function regionKeyToCommand(event: KeyEventLike, ghostActive: boolean): RegionCommand | null {
  if (event.ctrlKey || event.metaKey) return null;
  if (event.key === '?') return { kind: 'help' };
  if (ghostActive) {
    if (event.key === 'Enter') return { kind: 'commit' };
    if (event.key === 'Escape') return { kind: 'cancel' };
    const action = keyToAction(event);
    if (action?.kind === 'move') return action;
    if (action?.kind === 'resize') return action;
  }
  if (event.altKey) return null;
  if (event.key.length === 1) {
    if (event.key === ']') return { kind: 'next' };
    if (event.key === '[') return { kind: 'previous' };
    const lower = event.key.toLowerCase();
    if (lower === 'a') return { kind: 'assignee' };
    if (lower === MARKERS_KEY.toLowerCase()) return { kind: 'markers' };
    const type = TYPE_BY_KEY[lower];
    if (type) return { kind: 'start', type };
  }
  const number = jumpNumber(event);
  return number === null ? null : { kind: 'jump', number };
}

/**
 * The place number (1-9) a key press asks for. The typed character wins, so
 * Shift+1 on AZERTY and the numpad work. When the character is not a digit,
 * an unshifted top-row key (`Digit1`-`Digit9`) still counts: on AZERTY that
 * key types `&`, `é` and so on. Shift is excluded there so Shift+1 on a US
 * layout (`!`) stays unused.
 */
function jumpNumber(event: KeyEventLike): number | null {
  if (/^[0-9]$/.test(event.key)) return event.key === '0' ? null : Number(event.key);
  if (event.shiftKey) return null;
  const match = /^Digit([1-9])$/.exec(event.code ?? '');
  return match ? Number(match[1]) : null;
}

/** True for controls where a letter is text, not a command. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Gap in points between the selected field and a ghost box started from it. */
const GHOST_GAP = 8;

/**
 * Where a new ghost box starts: just below the selected field when there is
 * one on this page, else in the centre of the page.
 */
export function ghostStartRect(
  type: FieldType,
  page: PageInfo,
  near: Rect | null,
): Rect {
  const size = DEFAULT_FIELD_SIZE[type];
  if (near && near.page === page.page) {
    return clampRect({ page: page.page, x: near.x, y: near.y + near.height + GHOST_GAP, ...size }, page);
  }
  return clampRect(
    {
      page: page.page,
      x: roundPt((page.width - size.width) / 2),
      y: roundPt((page.height - size.height) / 2),
      ...size,
    },
    page,
  );
}

/** Keep the ghost's top-left corner and give it the new type's default size. */
export function retypeGhost(rect: Rect, type: FieldType, page: Pick<PageInfo, 'width' | 'height'>): Rect {
  return clampRect({ ...rect, ...DEFAULT_FIELD_SIZE[type] }, page);
}

/** Fields in reading order: page, then top to bottom, then left to right. */
export function readingOrder<T extends { id: string; rect: Rect }>(fields: readonly T[]): T[] {
  return [...fields].sort(
    (a, b) => a.rect.page - b.rect.page || a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id.localeCompare(b.id),
  );
}

/** The id after (or before) `current` in reading order, wrapping around. */
export function cycleField(
  fields: readonly { id: string; rect: Rect }[],
  current: string | null,
  direction: 1 | -1,
): string | null {
  const ordered = readingOrder(fields);
  if (ordered.length === 0) return null;
  const index = ordered.findIndex((field) => field.id === current);
  if (index === -1) return (direction === 1 ? ordered[0] : ordered.at(-1))?.id ?? null;
  return ordered[(index + direction + ordered.length) % ordered.length]?.id ?? null;
}

/** The shortcut table shown in the help dialog. One row per action; `keys` are alternatives, `+` joins a chord. */
export const PREPARE_SHORTCUTS: readonly { keys: readonly string[]; action: string }[] = [
  { keys: ['T', 'D', 'C', 'S', 'I'], action: 'Start placing a text, date, checkbox, signature or initials field' },
  { keys: [MARKERS_KEY], action: 'Show or hide numbered places for fields' },
  { keys: ['1-9'], action: 'Start a field at that numbered place on the visible page, or move the new field there' },
  { keys: ['Arrows'], action: 'Move the new or focused field 1 point' },
  { keys: ['Shift+Arrows'], action: 'Move it 10 points' },
  { keys: ['Alt+Arrows'], action: 'Change its size' },
  { keys: ['Enter'], action: 'Place the new field' },
  { keys: ['Esc'], action: 'Cancel the new field' },
  { keys: [']', '['], action: 'Go to the next or previous field' },
  { keys: ['A'], action: 'Switch the focused field between the preparer and the signer' },
  { keys: ['Delete'], action: 'Remove the focused field' },
  { keys: ['Ctrl+Z', 'Cmd+Z'], action: 'Undo the last add, removal or move' },
  { keys: ['?'], action: 'Show these shortcuts' },
];

/** The value for `aria-keyshortcuts` on the page region. */
export const REGION_KEYSHORTCUTS = [
  ...Object.values(PLACE_KEY),
  MARKERS_KEY,
  ...'123456789',
  ']',
  '[',
  'A',
  'Shift+?',
].join(' ');
