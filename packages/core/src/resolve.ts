import {
  safeParseSignRequest,
  type Field,
  type PageInfo,
  type Rect,
  type ResolvedField,
  type ResolvedRequest,
  type SignRequest,
  type SignRequestInput,
} from '@sign-pdf/spec';
import { SignPdfError, formatIssues } from './errors.ts';
import { rectWithinPage } from './geometry.ts';
import { canonicalJson, sha256Hex, utf8 } from './hash.ts';
import { assertPdfSize } from './limits.ts';
import type { TextItem } from './index.ts';
import { listAcroFields } from './inspect.ts';
import { loadPdf } from './load.ts';
import { extractText } from './pdfjs.ts';
import { loadTextFont, type TextFontOptions } from './text-font.ts';
import { assertFieldValue } from './value-check.ts';

export function validateRequest(input: unknown): SignRequest {
  const parsed = safeParseSignRequest(input);
  if (!parsed.success) {
    throw new SignPdfError('invalid-request', `Invalid sign request: ${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

/**
 * SHA-256 of the request's canonical JSON, as recorded in an audit record's
 * `requestSha256`. The request is validated first, so defaults the schema
 * fills in are part of the hash and equal requests always hash the same.
 */
export async function requestSha256(request: unknown): Promise<string> {
  return sha256Hex(utf8(canonicalJson(validateRequest(request))));
}

export async function assertDocumentHash(pdf: Uint8Array, request: SignRequest): Promise<void> {
  const actual = await sha256Hex(pdf);
  if (actual !== request.document.sha256) {
    throw new SignPdfError(
      'hash-mismatch',
      `The PDF does not match the request: expected SHA-256 ${request.document.sha256}, got ${actual}.`,
    );
  }
}

type AnchorPlacement = Extract<Field['placement'], { kind: 'anchor' }>;

export interface Line {
  runs: TextItem[];
  /** Lower-cased, whitespace-collapsed text of the whole line. */
  text: string;
  /** For each code unit of `text`: the run it came from and its position there, or null for a joining space. */
  map: Array<{ run: number; offset: number; length: number } | null>;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

/** Group a page's runs into lines (by vertical overlap) and order them for reading. */
export function buildLines(items: readonly TextItem[]): Line[] {
  const groups: Array<{ centre: number; height: number; runs: TextItem[] }> = [];
  const byTop = [...items].sort((p, q) => p.y - q.y || p.x - q.x);
  for (const item of byTop) {
    const centre = item.y + item.height / 2;
    const group = groups.find((g) => Math.abs(g.centre - centre) <= 0.5 * Math.min(g.height, item.height));
    if (group) group.runs.push(item);
    else groups.push({ centre, height: item.height, runs: [item] });
  }
  groups.sort((p, q) => p.centre - q.centre);
  return groups.map((group) => {
    const runs = group.runs.sort((p, q) => p.x - q.x);
    const line: Line = { runs, text: '', map: [] };
    runs.forEach((run, index) => {
      const source = collapse(run.text);
      const previous = runs[index - 1];
      if (previous && !line.text.endsWith(' ') && !source.startsWith(' ')) {
        // Runs that touch are one word split by the PDF producer; a visible gap is a space.
        const gap = run.x - (previous.x + previous.width);
        if (gap > 0.15 * Math.max(run.height, previous.height)) {
          line.text += ' ';
          line.map.push(null);
        }
      }
      for (let offset = 0; offset < source.length; offset++) {
        const char = source.charAt(offset);
        if (char === ' ' && (line.text === '' || line.text.endsWith(' '))) continue;
        // Lower-casing can change a character's length, so map every code unit back.
        for (const unit of char.toLowerCase()) {
          line.text += unit;
          line.map.push({ run: index, offset, length: source.length });
        }
      }
    });
    return line;
  });
}

/**
 * How closely a match fits the anchor text, best first:
 * - exact: the match is the whole text of the run(s) it covers
 * - word: the match does not start or end inside a word
 * - substring: any other match
 */
export type AnchorMatchRank = 'exact' | 'word' | 'substring';

const RANKS: readonly AnchorMatchRank[] = ['exact', 'word', 'substring'];

/** One place the anchor text occurs. `text` is the matched words as printed: untrusted document content. */
export interface AnchorMatch extends Rect {
  text: string;
  rank: AnchorMatchRank;
}

/**
 * Letters of the Latin, Greek and Cyrillic scripts, combining marks and digits.
 * Text in other scripts has no word boundaries here, so its word rank equals its substring rank.
 */
const WORD_CHAR = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{M}\p{Nd}]/u;
const isWordChar = (char: string | undefined): boolean => char !== undefined && char !== '' && WORD_CHAR.test(char);
const MAX_CANDIDATE_TEXT = 80;

/** The line's printed text (original case) for code units `from` to `to`, widened to whole words. */
export function printedWords(line: Line, from: number, to: number): string {
  let start = from;
  let end = to;
  while (start > 0 && isWordChar(line.text[start - 1]) && isWordChar(line.text[start])) start--;
  while (end < line.text.length && isWordChar(line.text[end]) && isWordChar(line.text[end - 1])) end++;
  let out = '';
  let previous: { run: number; offset: number } | null = null;
  for (let index = start; index < end; index++) {
    const unit = line.map[index] ?? null;
    if (!unit) {
      out += ' ';
    } else if (!previous || previous.run !== unit.run || previous.offset !== unit.offset) {
      out += collapse(line.runs[unit.run]?.text ?? '').charAt(unit.offset);
    }
    previous = unit;
  }
  return out.length > MAX_CANDIDATE_TEXT ? `${out.slice(0, MAX_CANDIDATE_TEXT - 1)}…` : out;
}

/** Offsets of the first and last non-space characters of a run's collapsed text. */
function trimmedBounds(run: TextItem): { first: number; last: number } {
  const source = collapse(run.text);
  return { first: source.search(/\S/), last: source.trimEnd().length - 1 };
}

function rankOf(line: Line, at: number, target: string): AnchorMatchRank {
  const first = line.map[at];
  const last = line.map[at + target.length - 1];
  const firstRun = first && line.runs[first.run];
  const lastRun = last && line.runs[last.run];
  if (first && last && firstRun && lastRun) {
    if (first.offset === trimmedBounds(firstRun).first && last.offset === trimmedBounds(lastRun).last) return 'exact';
  }
  const startsInWord = isWordChar(target[0]) && isWordChar(line.text[at - 1]);
  const endsInWord = isWordChar(target[target.length - 1]) && isWordChar(line.text[at + target.length]);
  return startsInWord || endsInWord ? 'substring' : 'word';
}

/**
 * The matches of the best rank that has any, in reading order. `occurrence`
 * counts within this list, so the anchor "Date" finds a "Date" label before
 * the word "dates" in a sentence.
 */
export function bestAnchorMatches(matches: readonly AnchorMatch[]): AnchorMatch[] {
  for (const rank of RANKS) {
    const ranked = matches.filter((match) => match.rank === rank);
    if (ranked.length > 0) return ranked;
  }
  return [];
}

/**
 * The box of the line's code units `from` to `to` (exclusive), or undefined when it has no width.
 * A run reports one box for all its text; a substring's extent is estimated by character count.
 * So the position of underscores inside a longer run ("Date ______") is an estimate.
 */
export function spanRect(line: Line, page: number, from: number, to: number): Rect | undefined {
  const first = line.map[from];
  const last = line.map[to - 1];
  const firstRun = first && line.runs[first.run];
  const lastRun = last && line.runs[last.run];
  if (!first || !last || !firstRun || !lastRun) return undefined;
  const left = firstRun.x + (firstRun.width * first.offset) / first.length;
  const right = lastRun.x + (lastRun.width * (last.offset + 1)) / last.length;
  let top = Infinity;
  let bottom = -Infinity;
  for (const run of line.runs.slice(first.run, last.run + 1)) {
    top = Math.min(top, run.y);
    bottom = Math.max(bottom, run.y + run.height);
  }
  if (!(right > left)) return undefined;
  return { page, x: left, y: top, width: right - left, height: bottom - top };
}

/** Every place the anchor text occurs, in reading order: page, then line, then left to right. */
export function findAnchorMatches(text: readonly TextItem[], needle: string, page?: number): AnchorMatch[] {
  const target = collapse(needle).trim().toLowerCase();
  if (target === '') return [];
  const pages = [...new Set(text.map((item) => item.page))].sort((p, q) => p - q);
  const matches: AnchorMatch[] = [];
  for (const pageNumber of pages) {
    if (page !== undefined && pageNumber !== page) continue;
    for (const line of buildLines(text.filter((item) => item.page === pageNumber))) {
      for (let at = line.text.indexOf(target); at >= 0; at = line.text.indexOf(target, at + 1)) {
        const rect = spanRect(line, pageNumber, at, at + target.length);
        if (!rect) continue;
        matches.push({
          ...rect,
          text: printedWords(line, at, at + target.length),
          rank: rankOf(line, at, target),
        });
      }
    }
  }
  return matches;
}

function placeByAnchor(placement: AnchorPlacement, match: Rect): Rect {
  const { align, width, height, dx, dy } = placement;
  let x = match.x;
  let y = match.y;
  if (align === 'right') {
    x = match.x + match.width;
    y = match.y + match.height / 2 - height / 2;
  } else if (align === 'below') {
    y = match.y + match.height;
  } else if (align === 'above') {
    y = match.y - height;
  }
  return { page: match.page, x: x + dx, y: y + dy, width, height };
}

function requirePage(pages: readonly PageInfo[], page: number, fieldId: string): PageInfo {
  const info = pages[page - 1];
  if (!info) {
    throw new SignPdfError(
      'page-out-of-range',
      `Field "${fieldId}" refers to page ${page}, but the PDF has ${pages.length} page(s).`,
      fieldId,
    );
  }
  return info;
}

/** Throws unless the rect names an existing page and lies inside it. */
export function assertRectOnPage(rect: Rect, pages: readonly PageInfo[], fieldId: string): void {
  const page = requirePage(pages, rect.page, fieldId);
  if (!rectWithinPage(rect, page)) {
    const r = (n: number) => Math.round(n * 100) / 100;
    throw new SignPdfError(
      'field-out-of-bounds',
      `Field "${fieldId}" (x ${r(rect.x)}, y ${r(rect.y)}, ${r(rect.width)} x ${r(rect.height)}) ` +
        `does not fit inside page ${rect.page} (${r(page.width)} x ${r(page.height)}).`,
      fieldId,
    );
  }
}

export type ResolveOptions = TextFontOptions;

/** A place an anchor's text occurs. `text` is untrusted document content. */
export type AnchorCandidate = Rect & { text: string };

/**
 * Something that resolved but may not be what the author meant. Data, not an
 * error: the field still resolves.
 *
 * 'anchor-ambiguous': the anchor text has more than one match of the rank that
 * was used and the request gave no `occurrence`, so the first was taken.
 * `candidates` lists the matches of that rank in reading order, at most
 * `MAX_ANCHOR_CANDIDATES` (the message gives the full count); candidate n is
 * `occurrence: n`.
 */
export const MAX_ANCHOR_CANDIDATES = 20;

export interface ResolveWarning {
  code: 'anchor-ambiguous';
  fieldId: string;
  message: string;
  rank: AnchorMatchRank;
  candidates: AnchorCandidate[];
}

export type ResolvedRequestWithWarnings = ResolvedRequest & { warnings: ResolveWarning[] };

/** The outcome of `resolveRequestCollect`: every field that resolved and every field error. */
export interface ResolveReport {
  /** Fields that resolved, in request order. */
  fields: ResolvedField[];
  /** One error per field that did not resolve, in request order. */
  errors: SignPdfError[];
  /** Warnings for fields that resolved, in request order. */
  warnings: ResolveWarning[];
  /** Present only when every field resolved. */
  resolved?: ResolvedRequestWithWarnings;
}

const RANK_NAMES: Record<AnchorMatchRank, string> = {
  exact: 'exact',
  word: 'whole-word',
  substring: 'substring',
};

/**
 * Whether the request as written (before defaults are filled in) sets
 * `occurrence` on field `index`. A request that was already parsed always has it.
 */
function occurrenceGiven(input: unknown, index: number): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const fields: unknown = (input as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return false;
  const field: unknown = fields[index];
  if (typeof field !== 'object' || field === null) return false;
  const placement: unknown = (field as { placement?: unknown }).placement;
  return typeof placement === 'object' && placement !== null && (placement as { occurrence?: unknown }).occurrence !== undefined;
}

export async function resolveRequest(
  pdf: Uint8Array,
  input: SignRequestInput,
  options: ResolveOptions = {},
): Promise<ResolvedRequestWithWarnings> {
  const report = await resolveRequestCollect(pdf, input, options);
  const [first] = report.errors;
  if (first) throw first;
  if (!report.resolved) throw new Error('resolveRequestCollect returned neither errors nor a result.');
  return report.resolved;
}

export async function resolveRequestCollect(
  pdf: Uint8Array,
  input: SignRequestInput,
  options: ResolveOptions = {},
): Promise<ResolveReport> {
  assertPdfSize(pdf.length);
  const request = validateRequest(input);
  await assertDocumentHash(pdf, request);
  const { doc, pages: geometry } = await loadPdf(pdf);
  const pages: PageInfo[] = geometry.map(({ page, width, height }) => ({ page, width, height }));

  // Text and form fields are read only when a placement needs them.
  const needsText = request.fields.some((field) => field.placement.kind === 'anchor');
  const needsForm = request.fields.some((field) => field.placement.kind === 'acroField');
  const text = needsText ? await extractText(pdf, geometry) : [];
  const acroFields = needsForm ? listAcroFields(doc, geometry) : [];

  // Values written into the request must be drawable, so the author learns now and not at signing.
  const hasText = request.fields.some((field) => 'value' in field && typeof field.value === 'string');
  const font = hasText ? await loadTextFont(options) : undefined;

  const resolveField = (field: Field, index: number): { field: ResolvedField; warning?: ResolveWarning } => {
    const placement = field.placement;
    let rect: Rect;
    let warning: ResolveWarning | undefined;
    if (placement.kind === 'rect') {
      const { page, x, y, width, height } = placement;
      rect = { page, x, y, width, height };
    } else if (placement.kind === 'anchor') {
      if (placement.page !== undefined) requirePage(pages, placement.page, field.id);
      const matches = bestAnchorMatches(findAnchorMatches(text, placement.text, placement.page));
      const match = matches[placement.occurrence - 1];
      const rank = matches[0]?.rank;
      if (!match || !rank) {
        const where = placement.page === undefined ? 'in the PDF' : `on page ${placement.page}`;
        const found = rank ? `${matches.length} ${RANK_NAMES[rank]} match(es)` : '0 matches';
        throw new SignPdfError(
          'anchor-not-found',
          `Field "${field.id}": occurrence ${placement.occurrence} of the anchor text ` +
            `${JSON.stringify(placement.text)} was not found ${where} (${found}).`,
          field.id,
        );
      }
      rect = placeByAnchor(placement, match);
      if (matches.length > 1 && !occurrenceGiven(input, index)) {
        warning = {
          code: 'anchor-ambiguous',
          fieldId: field.id,
          message:
            `Field "${field.id}": the anchor text ${JSON.stringify(placement.text)} has ${matches.length} ` +
            `${RANK_NAMES[rank]} matches; the first one was used.`,
          rank,
          candidates: matches.slice(0, MAX_ANCHOR_CANDIDATES).map(({ page, x, y, width, height, text: printed }) => ({ page, x, y, width, height, text: printed })),
        };
      }
    } else {
      const acro = acroFields.find((candidate) => candidate.name === placement.name);
      if (!acro?.rect) {
        const reason = acro ? 'has no visible widget' : 'does not exist';
        throw new SignPdfError(
          'acro-field-not-found',
          `Field "${field.id}": the form field ${JSON.stringify(placement.name)} ${reason}.`,
          field.id,
        );
      }
      rect = acro.rect;
    }
    assertRectOnPage(rect, pages, field.id);
    if (font && 'value' in field && typeof field.value === 'string') {
      assertFieldValue(field, rect, field.value, font);
    }
    return warning ? { field: { ...field, rect }, warning } : { field: { ...field, rect } };
  };

  const fields: ResolvedField[] = [];
  const errors: SignPdfError[] = [];
  const warnings: ResolveWarning[] = [];
  request.fields.forEach((field, index) => {
    try {
      const outcome = resolveField(field, index);
      fields.push(outcome.field);
      if (outcome.warning) warnings.push(outcome.warning);
    } catch (error) {
      // A field-level problem is reported and the next field is still checked; anything else is a bug.
      if (!(error instanceof SignPdfError)) throw error;
      errors.push(error);
    }
  });
  return errors.length === 0
    ? { fields, errors, warnings, resolved: { request, pages, fields, warnings } }
    : { fields, errors, warnings };
}
