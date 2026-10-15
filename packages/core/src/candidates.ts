import type { FieldType, PageInfo, PlacementInput, Rect } from '@sign-pdf/spec';
import { SignPdfError } from './errors.ts';
import { rectWithinPage } from './geometry.ts';
import type { AcroFieldInfo, InspectionWarning, TextItem } from './index.ts';
import { inspectPdf } from './inspect.ts';
import {
  bestAnchorMatches,
  buildLines,
  findAnchorMatches,
  printedWords,
  spanRect,
  type AnchorCandidate,
  type Line,
} from './resolve.ts';

import { MAX_PLACEMENT_CANDIDATES } from './limits.ts';

export { MAX_PLACEMENT_CANDIDATES };

/**
 * A likely place for a field. The candidate's own rect is the thing found:
 * the label, printed blank, table cell, or widget. `text` is document content
 * (a label, underscores, or form-field name) and is untrusted.
 */
export interface PlacementCandidate extends AnchorCandidate {
  /**
   * - label: text ending in ":" with nothing after it, or a caption above inferred open space
   * - line: a run of three or more underscores, with the short label before it if any;
   *   a drawn line next to a signature, initials or date label; or a table cell under a header
   * - widget: an existing AcroForm field with a visible widget
   */
  kind: 'label' | 'line' | 'widget';
  /** A coarse signal for deciding which suggestions need the closest review. */
  confidence: 'high' | 'medium' | 'low';
  /** One short clause naming the rule that proposed this candidate. Document-derived text is untrusted. */
  reason: string;
  /** Shared by a signature and its nearby date and/or print-name candidates. */
  group?: string;
  suggested: {
    /** A placement that puts a field on the line, after the label, or on the widget. */
    placement: PlacementInput;
    /** The field type the label or form field suggests, when it is obvious. */
    type?: FieldType;
  };
}

export interface PlacementCandidates {
  /** In reading order: page, then top to bottom, then left to right. */
  candidates: PlacementCandidate[];
  /** True when more than `max` candidates were found; `total` gives the count. */
  truncated: boolean;
  total: number;
}

export interface PlacementCandidateInput {
  pages: readonly PageInfo[];
  acroFields: readonly AcroFieldInfo[];
  text: readonly TextItem[];
  /** Horizontal lines drawn on the pages (`inspectPdf` with `rules: true`). */
  rules?: readonly Rect[];
}

export interface FindPlacementCandidatesOptions {
  /**
   * At most this many candidates are returned. Default `MAX_PLACEMENT_CANDIDATES`,
   * also used for NaN or an infinite value; other values are floored and clamped at 0.
   */
  max?: number;
}

/** Field sizes for a suggested placement, in points. A line sets its own width. */
const FIELD_HEIGHT: Record<FieldType, number> = { signature: 20, initials: 20, date: 14, text: 14, checkbox: 12 };
const LABEL_FIELD_WIDTH = 150;
const MIN_FIELD_WIDTH = 24;
/** Gap between a label and the field placed after it. */
const LABEL_GAP = 4;
/** Keep a field this far from the page's right edge. */
const PAGE_MARGIN = 18;
const MAX_LABEL_CHARS = 40;
const MAX_LABEL_WORDS = 5;
/**
 * A line or label is left out when a widget covers this share of it. Low,
 * because a substring's position is estimated by character count.
 */
const WIDGET_OVERLAP = 0.2;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const floor2 = (n: number): number => Math.floor(n * 100) / 100;

/** A type hint from a label or form field name, or undefined when none is obvious. */
export function typeHint(label: string): FieldType | undefined {
  const words = label.toLowerCase().replace(/[_\-.\d]+/g, ' ');
  if (/\binitials?\b/.test(words)) return 'initials';
  if (/\bdated?\b/.test(words)) return 'date';
  if (/\bsignature\b|\bsigned\b|\bsign here\b/.test(words)) return 'signature';
  if (/\b(name|title|company|address|e ?mail|phone|city|state|zip)\b/.test(words)) return 'text';
  return undefined;
}

function isShortLabel(text: string): boolean {
  return (
    text.length <= MAX_LABEL_CHARS &&
    text.split(' ').filter(Boolean).length <= MAX_LABEL_WORDS &&
    /[\p{L}]/u.test(text)
  );
}

/** The line's code units `from` to `to`, trimmed of spaces and of leading punctuation. */
function trimSpan(line: Line, from: number, to: number): { from: number; to: number } {
  let start = from;
  let end = to;
  while (start < end && !/[\p{L}\p{N}]/u.test(line.text.charAt(start))) start++;
  while (end > start && line.text.charAt(end - 1) === ' ') end--;
  return { from: start, to: end };
}

interface Found {
  kind: 'label' | 'line' | 'widget';
  text: string;
  rect: Rect;
  type?: FieldType;
  /** Where the field goes. */
  target: Rect;
  /** The label the anchor placement uses, with its rect. */
  label?: { text: string; rect: Rect };
  /** The part that must not overlap a widget for the candidate to stay. */
  footprint: Rect;
  /** Set for widgets. */
  acroName?: string;
  /** More specific explanation for a structural rule such as a table header. */
  reason?: string;
}

/** Labels and underscore runs on one line. */
function scanLine(line: Line, page: PageInfo): Found[] {
  const found: Found[] = [];
  const lineRight = (from: number): number => {
    // The field after a label stops before the next run on the line, or at the page margin.
    const fromX = spanRect(line, page.page, from - 1, from)?.x ?? 0;
    const next = line.runs.find((run) => run.x > fromX + 1);
    return next ? next.x - LABEL_GAP : page.width - PAGE_MARGIN;
  };
  let boundary = 0;
  const lines = [...line.text.matchAll(/_{3,}/g)];
  const consumeColonLabels = (until: number): void => {
    for (let at = line.text.indexOf(':', boundary); at >= 0 && at < until; at = line.text.indexOf(':', at + 1)) {
      const unit = line.map[at];
      const run = unit && line.runs[unit.run];
      // A label's colon ends its run ("Name:" then a gap), unlike "as follows: (1)" in prose.
      if (!unit || !run || unit.offset !== run.text.replace(/\s+/g, ' ').trimEnd().length - 1) continue;
      const rest = line.text.slice(at + 1, until);
      if (rest.trim() === '' && until < line.text.length) continue; // An underscore run follows: it takes the label.
      const span = trimSpan(line, boundary, at + 1);
      const text = printedWords(line, span.from, span.to);
      const rect = spanRect(line, page.page, span.from, span.to);
      boundary = at + 1;
      if (!rect || !isShortLabel(text)) continue;
      const type = typeHint(text);
      const height = FIELD_HEIGHT[type ?? 'text'];
      const x = rect.x + rect.width + LABEL_GAP;
      const width = Math.min(LABEL_FIELD_WIDTH, lineRight(at + 1) - x);
      if (width < MIN_FIELD_WIDTH) continue;
      const target = { page: page.page, x, y: Math.max(0, rect.y + rect.height / 2 - height / 2), width: floor2(width), height };
      found.push({ kind: 'label', text, rect, type, target, label: { text, rect }, footprint: target });
    }
  };
  for (const match of lines) {
    const from = match.index;
    const to = from + match[0].length;
    consumeColonLabels(from);
    const underline = spanRect(line, page.page, from, to);
    const span = trimSpan(line, boundary, from);
    boundary = to;
    if (!underline) continue;
    const labelText = span.to > span.from ? printedWords(line, span.from, span.to) : '';
    const labelRect = labelText ? spanRect(line, page.page, span.from, span.to) : undefined;
    const label = labelRect && isShortLabel(labelText) ? { text: labelText, rect: labelRect } : undefined;
    const type = label ? typeHint(label.text) : undefined;
    const height = FIELD_HEIGHT[type ?? 'text'];
    const target = {
      page: page.page,
      x: underline.x,
      y: Math.max(0, underline.y + underline.height - height),
      width: floor2(underline.width),
      height,
    };
    const rect = label ? union(label.rect, underline) : underline;
    found.push({
      kind: 'line',
      text: label ? label.text : printedWords(line, from, to),
      rect,
      type,
      target,
      label,
      footprint: underline,
    });
  }
  consumeColonLabels(line.text.length);
  return found;
}

/** Labels that name a blank to sign or date, the only ones matched to drawn lines. */
const DRAWN_LINE_TYPES: ReadonlySet<FieldType> = new Set(['signature', 'initials', 'date']);
/** How far a label may sit from its drawn line, in points. */
const LABEL_TO_LINE = 40;
/** The least height a field on a drawn line needs, in points. */
const MIN_DRAWN_FIELD_HEIGHT = 10;
/** A drawn line at least this share of the page wide is a border, not a caption's line. */
const FULL_WIDTH = 0.75;
/** The share of a text run's box, from the top, that a drawn line may cross. */
const INK_TOP = 0.2;
/** Text this short (a tick, an "X") may sit where the field goes: it marks the blank. */
const MARK_CHARS = 2;

interface Phrase {
  text: string;
  rect: Rect;
}

/**
 * The line's runs grouped into phrases: runs closer than about a character's
 * height belong together. A phrase stops before a run that opens a
 * parenthesis, so "Spouse's signature (if joint)" gives "Spouse's signature".
 */
function phrases(line: Line, page: number): Phrase[] {
  // `end` and `height` describe the last run seen, kept or not, so the rest of an aside stays with it.
  const out: Array<{ runs: TextItem[]; closed: boolean; end: number; height: number }> = [];
  for (const run of line.runs) {
    const last = out[out.length - 1];
    const gap = last ? run.x - last.end : Infinity;
    if (last && gap <= Math.max(3, 0.8 * Math.max(run.height, last.height))) {
      if (run.text.trim().startsWith('(')) last.closed = true;
      if (!last.closed) last.runs.push(run);
      last.end = run.x + run.width;
      last.height = run.height;
    } else {
      out.push({ runs: [run], closed: false, end: run.x + run.width, height: run.height });
    }
  }
  return out.map(({ runs }) => {
    const rect = runs.reduce((acc, run) => union(acc, { ...run, page }), { ...runs[0]!, page } as Rect);
    const text = runs
      .map((run) => run.text.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
    return { text, rect: { page, x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  });
}

type DrawnMode = 'lead-in' | 'caption' | 'box';
const DRAWN_MODES: readonly DrawnMode[] = ['lead-in', 'caption', 'box'];

/**
 * Fields on drawn lines next to signature, initials and date labels. A label
 * can be the lead-in to a line that starts just after it ("Your signature ▶
 * ____"), the caption printed under a line, or the heading of a box whose
 * bottom edge is a line. A mode fits when it leaves a clear space at least
 * `MIN_DRAWN_FIELD_HEIGHT` points tall on the line. Labels on one row use the
 * first mode, in that order, that fits all of them, since a form lays out a
 * row alike; when none does, each takes its own first fit. Labels on a row
 * that share a line split it: each takes the part from its own left edge to
 * the next label.
 */
function scanDrawnLines(lines: readonly Line[], rules: readonly Rect[], text: readonly TextItem[], page: PageInfo): Found[] {
  if (rules.length === 0) return [];
  const found: Found[] = [];
  // A run's box reaches a font size above its baseline; the top of that is mostly empty, so a line may cross it.
  const blocking = text
    .filter((item) => item.text.trim().length > MARK_CHARS)
    .map((item) => ({ ...item, y: item.y + INK_TOP * item.height, height: (1 - INK_TOP) * item.height }));
  for (const line of lines) {
    const row = phrases(line, page.page);
    // An aside such as "(if joint return, both must sign)" belongs to the label before it.
    const labels = row.filter((phrase) => !phrase.text.startsWith('('));
    const fits = labels.map((phrase, index) => {
      const type = typeHint(phrase.text);
      if (!type || !DRAWN_LINE_TYPES.has(type) || !isShortLabel(phrase.text)) return undefined;
      const options = new Map<DrawnMode, Found>();
      for (const mode of DRAWN_MODES) {
        const fit = fitOnDrawnLine(mode, phrase, type, labels[index - 1], labels[index + 1], rules, blocking, page);
        if (fit) options.set(mode, fit);
      }
      return options;
    });
    const wanted = fits.filter((options) => options !== undefined && options.size > 0);
    const shared = DRAWN_MODES.find((mode) => wanted.every((options) => options?.has(mode)));
    for (const options of wanted) {
      const fit = (shared && options?.get(shared)) ?? DRAWN_MODES.map((mode) => options?.get(mode)).find(Boolean);
      if (fit) found.push(fit);
    }
  }
  return found;
}

/**
 * A short signature/date caption can mark an open blank immediately above it.
 * Keep the inferred blank modest and require clear space: a nearby drawn rule
 * belongs to the drawn-line detector, while a grid belongs to the table rule.
 */
function scanOpenCaptions(lines: readonly Line[], rules: readonly Rect[], text: readonly TextItem[], page: PageInfo): Found[] {
  const found: Found[] = [];
  for (const line of lines) {
    for (const phrase of phrases(line, page.page)) {
      const type = typeHint(phrase.text);
      if (!type || !DRAWN_LINE_TYPES.has(type) || !isShortLabel(phrase.text) || /_{3,}/.test(phrase.text)) continue;
      const height = FIELD_HEIGHT[type];
      const target = {
        page: page.page,
        x: round2(phrase.rect.x),
        y: round2(phrase.rect.y - height),
        width: floor2(Math.min(220, page.width - PAGE_MARGIN - phrase.rect.x)),
        height,
      };
      if (target.width < MIN_FIELD_WIDTH) continue;
      const bandTop = target.y - LABEL_TO_LINE;
      const hasNearbyRule = rules.some(
        (rule) =>
          rule.x < target.x + target.width &&
          rule.x + rule.width > target.x &&
          rule.y >= bandTop &&
          rule.y <= phrase.rect.y + phrase.rect.height + 1,
      );
      if (hasNearbyRule) continue;
      const occupied = text.some((item) => {
        if (item.page !== page.page || item.x === phrase.rect.x && item.y === phrase.rect.y && item.text === phrase.text) return false;
        return overlapShare(target, { ...item, page: page.page }) > 0;
      });
      if (occupied) continue;
      found.push({
        kind: 'label',
        text: phrase.text,
        rect: phrase.rect,
        type,
        target,
        label: { text: phrase.text, rect: phrase.rect },
        footprint: target,
        reason: `Label '${phrase.text}' with clear space above it`,
      });
    }
  }
  return found;
}

/**
 * A pair of short Signature/Date headers over a ruled table identifies the
 * first data row below the header. `inspectPdf` supplies the horizontal rules;
 * evenly splitting their shared span avoids another PDF parsing pass.
 */
function scanTableCells(lines: readonly Line[], rules: readonly Rect[], page: PageInfo): Found[] {
  const horizontals = rules
    .filter((rule) => rule.height <= 1 && rule.width >= 18)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const found: Found[] = [];
  for (const line of lines) {
    const headers = phrases(line, page.page)
      .map((phrase) => ({ phrase, type: typeHint(phrase.text) }))
      .filter(
        (entry): entry is { phrase: Phrase; type: FieldType } =>
          (entry.type === 'signature' || entry.type === 'date') &&
          /^(?:signature|date)\s*:?[\s]*$/i.test(entry.phrase.text) &&
          isShortLabel(entry.phrase.text),
      )
      .sort((a, b) => a.phrase.rect.x - b.phrase.rect.x);
    if (headers.length < 2) continue;
    const first = headers[0]!.phrase.rect;
    const last = headers[headers.length - 1]!.phrase.rect;
    const topRule = [...horizontals]
      .filter((rule) => rule.y <= first.y + 1 && rule.x <= first.x && rule.x + rule.width >= last.x + last.width)
      .at(-1);
    const headerBottom = horizontals.find(
      (rule) => rule.y > last.y + last.height && rule.x <= first.x && rule.x + rule.width >= last.x + last.width,
    );
    if (!topRule || !headerBottom || headerBottom.y <= topRule.y) continue;
    // The data row is the next ruled row below the headers. Its top and bottom
    // must span the same table width, so isolated caption lines cannot qualify.
    const dataBottom = horizontals.find(
      (rule) => rule.y > headerBottom.y + 1 && rule.x <= first.x && rule.x + rule.width >= last.x + last.width,
    );
    if (!dataBottom || dataBottom.y - headerBottom.y < 2 * MIN_DRAWN_FIELD_HEIGHT) continue;
    const spanLeft = Math.max(topRule.x, headerBottom.x, dataBottom.x);
    const spanRight = Math.min(
      topRule.x + topRule.width,
      headerBottom.x + headerBottom.width,
      dataBottom.x + dataBottom.width,
    );
    const spanWidth = spanRight - spanLeft;
    if (spanWidth < headers.length * (MIN_FIELD_WIDTH + 4)) continue;
    headers.forEach(({ phrase, type }, index) => {
      const cellWidth = spanWidth / headers.length;
      const target = {
        page: page.page,
        x: round2(spanLeft + index * cellWidth + 2),
        y: round2(headerBottom.y + 2),
        width: floor2(cellWidth - 4),
        height: floor2(dataBottom.y - headerBottom.y - 4),
      };
      found.push({
        kind: 'line',
        text: phrase.text,
        rect: target,
        type,
        target,
        label: { text: phrase.text, rect: phrase.rect },
        footprint: target,
        reason: `Header '${phrase.text}' identifies a blank table cell`,
      });
    });
  }
  return found;
}

function fitOnDrawnLine(
  mode: DrawnMode,
  phrase: Phrase,
  type: FieldType,
  previous: Phrase | undefined,
  next: Phrase | undefined,
  rules: readonly Rect[],
  blocking: readonly TextItem[],
  page: PageInfo,
): Found | undefined {
  const label = phrase.rect;
  const labelRight = label.x + label.width;
  const labelBottom = label.y + label.height;
  const spans = (rule: Rect): boolean => rule.x <= label.x + 6 && rule.x + rule.width >= label.x + Math.min(label.width, 20);
  const nearest = (keep: (rule: Rect) => boolean, distance: (rule: Rect) => number): Rect | undefined =>
    rules.filter(keep).sort((a, b) => distance(a) - distance(b))[0];
  const rule =
    mode === 'lead-in'
      ? nearest(
          (r) => r.x >= labelRight - 4 && r.x <= labelRight + LABEL_TO_LINE && r.y >= label.y + label.height / 2 && r.y <= labelBottom + 4,
          (r) => r.x - labelRight,
        )
      : mode === 'caption'
        ? // A line across most of the page is a border between parts of the form, not a line to sign on.
          // So is the top edge of a box the label sits in: a line of the same extent below the label closes it.
          nearest(
            (r) =>
              spans(r) &&
              r.y <= label.y + 1 &&
              r.y >= label.y - 14 &&
              r.width < FULL_WIDTH * page.width &&
              !rules.some(
                (bottom) =>
                  bottom.y > labelBottom &&
                  bottom.y <= labelBottom + LABEL_TO_LINE &&
                  Math.abs(bottom.x - r.x) < 2 &&
                  Math.abs(bottom.width - r.width) < 2,
              ),
            (r) => label.y - r.y,
          )
        : nearest((r) => spans(r) && r.y >= labelBottom + 1 && r.y <= labelBottom + LABEL_TO_LINE, (r) => r.y - labelBottom);
  if (!rule) return undefined;
  const right = Math.min(rule.x + rule.width, next ? next.rect.x - LABEL_GAP : Infinity, page.width - PAGE_MARGIN);
  // A label that shares its line with the label before it starts its own part of the line.
  const shared = previous !== undefined && previous.rect.x + previous.rect.width > rule.x;
  const x = mode === 'lead-in' ? Math.max(rule.x, labelRight) : shared ? Math.max(rule.x, label.x - 2) : rule.x;
  const width = right - x;
  if (width < MIN_FIELD_WIDTH) return undefined;
  // The field grows up from the line until it meets printed text, the label included.
  const ceiling = Math.max(
    rule.y - FIELD_HEIGHT[type],
    ...blocking
      .filter((item) => item.x < right && item.x + item.width > x && item.y + item.height <= rule.y + 1)
      .map((item) => item.y + item.height + 1),
    ...(mode === 'box' ? [labelBottom + 1] : []),
  );
  const height = round2(rule.y - ceiling);
  if (height < MIN_DRAWN_FIELD_HEIGHT) return undefined;
  const target = { page: page.page, x: round2(x), y: round2(rule.y - height), width: floor2(width), height };
  const clear = blocking.every((item) => overlapShare(target, { ...item, page: page.page }) === 0);
  if (!clear) return undefined;
  const drawn = { page: page.page, x: target.x, y: rule.y, width: target.width, height: Math.max(rule.height, 0.01) };
  return {
    kind: 'line',
    text: phrase.text,
    rect: union(label, drawn),
    type,
    target,
    label: { text: phrase.text, rect: label },
    footprint: target,
  };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    page: a.page,
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function overlapShare(a: Rect, b: Rect): number {
  if (a.page !== b.page) return 0;
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / (a.width * a.height) : 0;
}

/** Orders rects by position alone, so the result does not depend on input order. */
const byPosition = (a: Found, b: Found): number =>
  a.rect.page - b.rect.page ||
  a.rect.y - b.rect.y ||
  a.rect.x - b.rect.x ||
  a.rect.height - b.rect.height ||
  a.rect.width - b.rect.width ||
  (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);

/**
 * Reading order: page, then rows top to bottom, then left to right. Rects are
 * taken top first; one joins a row when its centre lies within the row's first
 * rect, or that rect's centre lies within it. Rows are anchored on their first
 * rect, so the result does not depend on input order.
 */
function inReadingOrder(found: readonly Found[]): Found[] {
  const rows: Array<{ first: Rect; centre: number; items: Found[] }> = [];
  const within = (y: number, rect: Rect): boolean => y >= rect.y && y <= rect.y + rect.height;
  for (const item of [...found].sort(byPosition)) {
    const centre = item.rect.y + item.rect.height / 2;
    const row = rows.find(
      (r) => r.first.page === item.rect.page && (within(centre, r.first) || within(r.centre, item.rect)),
    );
    if (row) row.items.push(item);
    else rows.push({ first: item.rect, centre, items: [item] });
  }
  rows.sort((p, q) => p.first.page - q.first.page || p.centre - q.centre);
  return rows.flatMap((row) => row.items.sort((a, b) => a.rect.x - b.rect.x || byPosition(a, b)));
}

function widgetType(field: AcroFieldInfo): FieldType | undefined {
  if (field.type === 'checkbox') return 'checkbox';
  if (field.type === 'signature') return 'signature';
  // A long name is often the sentence around the field ("from the date of disclosure"), not a label.
  if (field.type === 'text') return (isShortLabel(field.name) ? typeHint(field.name) : undefined) ?? 'text';
  return undefined;
}

/**
 * Confidence policy, using only candidate kind, type-hint strength, widget
 * overlap and anchor rank:
 *
 * | Tier   | Signals |
 * |--------|---------|
 * | high   | A visible widget, or a typed line blank with no covering widget. |
 * | medium | A typed label with a resolvable anchor (including a ranked repeat). |
 * | low    | No type hint, no widget, or only a generic line/rect suggestion. |
 *
 * This is a review tier, not a probability. The label-only open-space rule is
 * medium because its blank geometry is inferred rather than printed.
 */
function candidateConfidence(found: Found, placement: PlacementInput, widgetOverlap: number): PlacementCandidate['confidence'] {
  if (found.kind === 'widget' && found.acroName !== undefined) return 'high';
  const strongType = found.type !== undefined && found.type !== 'text';
  if (found.kind === 'line' && strongType && found.label && widgetOverlap < WIDGET_OVERLAP) return 'high';
  const anchorRank = placement.kind === 'anchor' ? placement.occurrence ?? 1 : 0;
  if (found.type && anchorRank > 0) return 'medium';
  return 'low';
}

const SIGNATURE_GROUP_DISTANCE = 120;

function rectDistance(a: PlacementCandidate, b: PlacementCandidate): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

/**
 * Group each signature with its nearest same-page date/print-name candidates
 * within 120 points (edge-to-edge). This post-pass preserves candidate order,
 * geometry, numbering and suggestions.
 */
function groupSignatureBlocks(candidates: PlacementCandidate[]): PlacementCandidate[] {
  const signatures = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.suggested.type === 'signature');
  const companions = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        candidate.suggested.type === 'date' ||
        (candidate.suggested.type === 'text' &&
          /\b(?:print(?:ed)?\s*name|name\s*\(print\))(?:[_\s-]*\d+)?\b/i.test(candidate.text)),
    );
  const members = new Map<number, number[]>();
  for (const { candidate: companion, index: companionIndex } of companions) {
    const nearest = signatures
      .filter(({ candidate: signature }) => signature.page === companion.page)
      .map((entry) => ({ ...entry, distance: rectDistance(entry.candidate, companion) }))
      .filter((entry) => entry.distance <= SIGNATURE_GROUP_DISTANCE)
      .sort((a, b) => a.distance - b.distance || a.index - b.index)[0];
    if (!nearest) continue;
    const indexes = members.get(nearest.index) ?? [];
    indexes.push(companionIndex);
    members.set(nearest.index, indexes);
  }
  const ids = new Map<number, string>();
  const pageCounts = new Map<number, number>();
  for (const { candidate, index } of signatures) {
    if (!members.has(index)) continue;
    const number = (pageCounts.get(candidate.page) ?? 0) + 1;
    pageCounts.set(candidate.page, number);
    ids.set(index, `sig-block-p${candidate.page}-${number}`);
  }
  const groupForIndex = new Map<number, string>();
  for (const [signatureIndex, companionIndexes] of members) {
    const group = ids.get(signatureIndex);
    if (!group) continue;
    groupForIndex.set(signatureIndex, group);
    companionIndexes.forEach((index) => groupForIndex.set(index, group));
  }
  return candidates.map((candidate, index) => {
    const group = groupForIndex.get(index);
    return group ? { ...candidate, group } : candidate;
  });
}

/** An anchor placement on the label that lands on the target, or a rect placement when the label is not a findable anchor. */
function suggestPlacement(found: Found, input: PlacementCandidateInput, pageInfo: PageInfo): PlacementInput {
  const { target } = found;
  const rectPlacement: PlacementInput = {
    kind: 'rect',
    page: target.page,
    x: round2(target.x),
    y: round2(target.y),
    width: target.width,
    height: target.height,
  };
  if (!found.label) return rectPlacement;
  const label = found.label;
  const matches = bestAnchorMatches(findAnchorMatches(input.text, label.text, target.page));
  const index = matches.findIndex(
    (match) => Math.abs(match.x - label.rect.x) < 0.5 && Math.abs(match.y - label.rect.y) < 0.5,
  );
  const match = matches[index];
  if (!match) return rectPlacement;
  // align 'right' puts the field at the label's right edge, centred on it; dx and dy move it onto the target.
  const dx = round2(target.x - (match.x + match.width));
  const dy = round2(target.y - (match.y + match.height / 2 - target.height / 2));
  const landed = { page: target.page, x: match.x + match.width + dx, y: match.y + match.height / 2 - target.height / 2 + dy, width: target.width, height: target.height };
  if (!rectWithinPage(landed, pageInfo)) return rectPlacement;
  return {
    kind: 'anchor',
    text: label.text,
    page: target.page,
    ...(matches.length > 1 ? { occurrence: index + 1 } : {}),
    align: 'right',
    ...(dx !== 0 ? { dx } : {}),
    ...(dy !== 0 ? { dy } : {}),
    width: target.width,
    height: target.height,
  };
}

export function findPlacementCandidates(
  input: PlacementCandidateInput,
  options: FindPlacementCandidatesOptions = {},
): PlacementCandidates {
  const requested = options.max ?? MAX_PLACEMENT_CANDIDATES;
  const max = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : MAX_PLACEMENT_CANDIDATES;
  const widgets: Found[] = [];
  for (const field of input.acroFields) {
    if (!field.rect || field.readOnly || field.type === 'button') continue;
    const type = widgetType(field);
    widgets.push({
      kind: 'widget',
      text: field.name,
      rect: field.rect,
      target: field.rect,
      footprint: field.rect,
      acroName: field.name,
      ...(type ? { type } : {}),
    });
  }
  const textFound: Found[] = [];
  for (const page of input.pages) {
    const items = input.text.filter((item) => item.page === page.page);
    if (items.length === 0) continue;
    const lines = buildLines(items);
    const typed = lines.flatMap((line) => scanLine(line, page));
    const rules = (input.rules ?? []).filter((rule) => rule.page === page.page);
    // A typed label or underscore run already covers its blank; a drawn line adds only new places.
    const drawn = scanDrawnLines(lines, rules, items, page).filter(
      (found) => !typed.some((other) => overlapShare(found.footprint, other.footprint) > 0 || overlapShare(found.label?.rect ?? found.rect, other.rect) > 0.5),
    );
    const tableCells = scanTableCells(lines, rules, page);
    const uniqueDrawn = drawn.filter(
      (found) => !tableCells.some((cell) => overlapShare(found.label?.rect ?? found.rect, cell.label?.rect ?? cell.rect) > 0.5),
    );
    const openCaptions = scanOpenCaptions(lines, rules, items, page);
    const uniqueOpenCaptions = openCaptions.filter(
      (found) =>
        ![...typed, ...uniqueDrawn, ...tableCells].some(
          (other) =>
            overlapShare(found.label?.rect ?? found.rect, other.label?.rect ?? other.rect) > 0.5 ||
            overlapShare(found.target, other.footprint) > 0.5,
        ),
    );
    for (const found of [...typed, ...uniqueDrawn, ...tableCells, ...uniqueOpenCaptions]) {
      // An existing form field over the line or after the label is the better target.
      if (widgets.some((widget) => overlapShare(found.footprint, widget.rect) >= WIDGET_OVERLAP)) continue;
      if (rectWithinPage(found.target, page)) textFound.push(found);
    }
  }
  const all = inReadingOrder([...textFound, ...widgets]);
  const kept = all.slice(0, max);
  const candidates = kept.map((found): PlacementCandidate => {
    const pageInfo = input.pages[found.rect.page - 1] ?? { page: found.rect.page, width: Infinity, height: Infinity };
    const placement: PlacementInput =
      found.acroName !== undefined
        ? { kind: 'acroField', name: found.acroName }
        : suggestPlacement(found, input, pageInfo);
    const { page, x, y, width, height } = found.rect;
    const widgetOverlap = Math.max(
      0,
      ...widgets.map((widget) => overlapShare(found.footprint, widget.rect)),
    );
    const confidence = candidateConfidence(found, placement, widgetOverlap);
    return {
      kind: found.kind,
      text: found.text,
      page,
      x,
      y,
      width,
      height,
      confidence,
      reason:
        found.reason ??
        (found.kind === 'widget'
          ? 'Existing visible AcroForm field'
          : found.kind === 'line'
            ? found.label
              ? `Label '${found.label.text}' marks a printed blank line`
              : 'Printed underscore run'
            : `Label '${found.text}' with empty space to its right`),
      suggested: found.type ? { placement, type: found.type } : { placement },
    };
  });
  return { candidates: groupSignatureBlocks(candidates), truncated: all.length > kept.length, total: all.length };
}

/** The placement candidates of a PDF, with the document's hash and pages. */
export interface PdfCandidates {
  sha256: string;
  pages: PageInfo[];
  warnings: InspectionWarning[];
  /** In reading order. Candidate n is `candidates[n - 1]`. */
  candidates: PlacementCandidate[];
  /** True when more than `max` candidates were found; `total` gives the count. */
  truncated: boolean;
  total: number;
}

/**
 * Inspect a PDF and find its placement candidates, at most `max` (default
 * `MAX_PLACEMENT_CANDIDATES`). A `max` that is not a whole number of at least 1
 * throws SignPdfError 'invalid-argument'.
 */
export async function findCandidatesInPdf(pdf: Uint8Array, options: { max?: number } = {}): Promise<PdfCandidates> {
  const max = options.max ?? MAX_PLACEMENT_CANDIDATES;
  if (!Number.isInteger(max) || max < 1) {
    throw new SignPdfError(
      'invalid-argument',
      `The candidate limit must be a whole number of at least 1, got ${max}.`,
      undefined,
      'Pass max as a whole number of at least 1.',
    );
  }
  const inspection = await inspectPdf(pdf, { rules: true });
  const found = findPlacementCandidates(inspection, { max });
  return { sha256: inspection.sha256, pages: inspection.pages, warnings: inspection.warnings, ...found };
}
