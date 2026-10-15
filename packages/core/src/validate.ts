/**
 * Validate a sign request against a PDF and report, per field, either the
 * resolved rectangle or what was wrong and how to fix it. The rules themselves
 * live in `resolveRequestCollect`, which reports every bad field in one pass;
 * this module adds hints an agent can act on. Shared by every interface.
 */
import { SignPdfError } from './errors.ts';
import type { PdfInspection, TextItem } from './index.ts';
import { inspectPdf } from './inspect.ts';
import { resolveRequestCollect, type AnchorCandidate, type ResolveReport, type ResolveWarning } from './resolve.ts';
import {
  isSigningField,
  safeParseSignRequest,
  type PageInfo,
  type Rect,
  type ResolvedField,
  type ResolvedRequest,
  type SignRequest,
  type SignRequestInput,
} from '@sign-pdf/spec';

/** A line of page text close to an anchor that was not found. Untrusted document content. */
export interface NearestText extends Rect {
  text: string;
  /** 0 to 1; 1 means the anchor text occurs in this line. */
  score: number;
}

export interface ValidationIssue {
  code: string;
  message: string;
  /** The field the issue refers to, when there is one. */
  fieldId?: string;
  /** Location inside the request JSON, for schema errors (for example `fields.0.placement.width`). */
  path?: string;
  /** What to change. Written by this tool, not taken from the document. */
  hint?: string;
  /** Untrusted document content: page text that resembles the anchor. */
  nearestText?: NearestText[];
  /** Untrusted document content: names of the form fields the PDF has. */
  availableFormFields?: string[];
  /**
   * For 'anchor-ambiguous': every place the anchor text matched, in reading
   * order; candidate n is `occurrence: n`. `text` is untrusted document content.
   */
  candidates?: AnchorCandidate[];
}

export interface FieldReport {
  id: string;
  type: ResolvedField['type'];
  assignee: ResolvedField['assignee'];
  required: boolean;
  placement: ResolvedField['placement']['kind'];
  /** Resolved position: PDF points, top-left origin of the displayed page, y down. */
  rect: Rect;
}

export interface ValidationReport {
  ok: boolean;
  /** SHA-256 of the PDF that was given. */
  sha256: string;
  pages: PageInfo[];
  /** Fields that resolved, with their rectangles. */
  fields: FieldReport[];
  errors: ValidationIssue[];
  /** Things that resolve but look wrong, such as overlapping fields. */
  warnings: ValidationIssue[];
}

export interface ValidationResult {
  report: ValidationReport;
  /** Present only when the whole request is valid. */
  resolved?: ResolvedRequest;
}

const round = (n: number): number => Math.round(n * 100) / 100;

function roundRect(rect: Rect): Rect {
  return { page: rect.page, x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

interface TextLine extends Rect {
  text: string;
}

/** Group text runs into lines by vertical overlap, left to right. */
function buildLines(items: readonly TextItem[]): TextLine[] {
  const groups: Array<{ page: number; centre: number; height: number; runs: TextItem[] }> = [];
  for (const item of [...items].sort((p, q) => p.page - q.page || p.y - q.y || p.x - q.x)) {
    const centre = item.y + item.height / 2;
    const group = groups.find(
      (g) => g.page === item.page && Math.abs(g.centre - centre) <= 0.5 * Math.min(g.height, item.height),
    );
    if (group) group.runs.push(item);
    else groups.push({ page: item.page, centre, height: item.height, runs: [item] });
  }
  return groups.map(({ page, runs }) => {
    runs.sort((p, q) => p.x - q.x);
    const x = Math.min(...runs.map((run) => run.x));
    const y = Math.min(...runs.map((run) => run.y));
    const right = Math.max(...runs.map((run) => run.x + run.width));
    const bottom = Math.max(...runs.map((run) => run.y + run.height));
    return { page, x, y, width: right - x, height: bottom - y, text: runs.map((run) => run.text).join(' ') };
  });
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

/** Dice similarity of two words by character pairs, 0 to 1. */
function wordSimilarity(p: string, q: string): number {
  if (p === q) return 1;
  if (p.length < 2 || q.length < 2) return 0;
  const left = bigrams(p);
  const right = bigrams(q);
  let shared = 0;
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0);
  return (2 * shared) / (p.length - 1 + (q.length - 1));
}

/** How well the candidate line covers the needle's words, weighted by word length. */
function coverage(needle: string, candidate: string): number {
  const words = candidate.split(' ');
  let total = 0;
  let score = 0;
  for (const word of needle.split(' ')) {
    total += word.length;
    score += word.length * Math.max(0, ...words.map((other) => wordSimilarity(word, other)));
  }
  return total === 0 ? 0 : score / total;
}

const MAX_SUGGESTIONS = 5;
const MIN_SCORE = 0.5;
const MAX_SUGGESTION_LENGTH = 160;

/** The lines of page text most like `needle`, best first. */
export function nearestTextMatches(text: readonly TextItem[], needle: string, page?: number): NearestText[] {
  const target = normalize(needle);
  if (target.length < 2) return [];
  return buildLines(page === undefined ? text : text.filter((item) => item.page === page))
    .map((line) => {
      const candidate = normalize(line.text);
      // Capped below 1 so that only a real occurrence scores 1.
      const score = candidate.includes(target) ? 1 : Math.min(0.99, coverage(target, candidate));
      return {
        ...roundRect(line),
        text: line.text.length > MAX_SUGGESTION_LENGTH ? `${line.text.slice(0, MAX_SUGGESTION_LENGTH)}...` : line.text,
        score: round(score),
      };
    })
    .filter((line) => line.score >= MIN_SCORE)
    .sort((p, q) => q.score - p.score || p.text.length - q.text.length || p.page - q.page || p.y - q.y)
    .slice(0, MAX_SUGGESTIONS);
}

function fieldIdAt(input: unknown, index: PropertyKey | undefined): string | undefined {
  if (typeof index !== 'number' || typeof input !== 'object' || input === null) return undefined;
  const fields: unknown = (input as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return undefined;
  const field: unknown = fields[index];
  if (typeof field !== 'object' || field === null) return undefined;
  const id: unknown = (field as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function rectsOverlap(p: Rect, q: Rect): boolean {
  if (p.page !== q.page) return false;
  const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x);
  const h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
  // Ignore boxes that merely touch.
  return w > 1 && h > 1;
}

function findWarnings(request: SignRequest, fields: readonly ResolvedField[]): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  if (!request.fields.some(isSigningField)) {
    warnings.push({
      code: 'no-signing-field',
      message: 'The request has no signature or initials field.',
      hint: 'Add a field of type "signature" where the human must sign, unless the document only needs filling in.',
    });
  }
  for (const field of request.fields) {
    if (field.type === 'checkbox' && field.assignee === 'agent' && field.required && field.value === false) {
      warnings.push({
        code: 'required-checkbox-unchecked',
        fieldId: field.id,
        message: `Field "${field.id}" is a required checkbox that you set to false. A required checkbox must be checked before the document can be signed.`,
        hint: 'Set value to true, or set required to false, or assign the checkbox to the human.',
      });
    }
  }
  fields.forEach((field, index) => {
    for (const other of fields.slice(index + 1)) {
      if (rectsOverlap(field.rect, other.rect)) {
        warnings.push({
          code: 'fields-overlap',
          fieldId: field.id,
          message: `Fields "${field.id}" and "${other.id}" overlap on page ${field.rect.page}.`,
          hint: 'Move or shrink one of them, then render a preview to check.',
        });
      }
    }
  });
  return warnings;
}

function ambiguityIssue(warning: ResolveWarning): ValidationIssue {
  return {
    code: warning.code,
    fieldId: warning.fieldId,
    message: warning.message,
    hint:
      'Check that candidate 1 is the right place. To use another, set placement.occurrence to its number ' +
      '(candidate n is occurrence n), or make the anchor text longer so it matches one place. ' +
      'A preview marks each candidate with its number.',
    candidates: warning.candidates.map((candidate) => ({ ...roundRect(candidate), text: candidate.text })),
  };
}

function pageOf(pages: readonly PageInfo[], page: number | undefined): string {
  const info = page === undefined ? undefined : pages[page - 1];
  return info ? `Page ${info.page} is ${round(info.width)} x ${round(info.height)} points.` : '';
}

async function withHint(
  error: SignPdfError,
  request: SignRequest,
  inspection: PdfInspection,
  pdfText: () => Promise<TextItem[]>,
): Promise<ValidationIssue> {
  const issue: ValidationIssue = { code: error.code, message: error.message };
  if (error.fieldId !== undefined) issue.fieldId = error.fieldId;
  const field = request.fields.find((candidate) => candidate.id === error.fieldId);
  const placement = field?.placement;
  // Compared as a string so that codes added by newer versions of core still get a hint.
  const code: string = error.code;
  switch (code) {
    case 'anchor-not-found': {
      if (placement?.kind !== 'anchor') break;
      const nearest = nearestTextMatches(await pdfText(), placement.text, placement.page);
      const exact = nearest.filter((line) => line.score === 1).length;
      if (nearest.length > 0) issue.nearestText = nearest;
      if (exact > 0 && placement.occurrence > 1) {
        issue.hint = `The text occurs, but fewer than ${placement.occurrence} times. Lower "occurrence", or remove "page" if the text is on another page.`;
      } else if (nearest.length > 0) {
        issue.hint =
          'The anchor text was not found as written. Copy the exact text of one printed line from nearestText (an anchor cannot span lines), or use a rect placement.';
      } else {
        issue.hint =
          'No similar text was found. The page may be a scan without a text layer: run inspect to see the text that exists, or use a rect placement and check it with a preview.';
      }
      break;
    }
    case 'acro-field-not-found': {
      issue.availableFormFields = inspection.acroFields.filter((acro) => acro.rect).map((acro) => acro.name);
      issue.hint =
        issue.availableFormFields.length > 0
          ? 'Use one of the names in availableFormFields exactly as written.'
          : 'This PDF has no usable form fields. Use an anchor or rect placement.';
      break;
    }
    case 'page-out-of-range':
      issue.hint = `The PDF has ${inspection.pages.length} page(s); pages are numbered from 1.`;
      break;
    case 'field-out-of-bounds': {
      const page = placement && 'page' in placement ? placement.page : undefined;
      issue.hint =
        `The whole box must lie inside the page (0 <= x, x + width <= page width, 0 <= y, y + height <= page height). ${pageOf(inspection.pages, page)} ` +
        'Reduce width or height, or change x / y (for an anchor: dx / dy or align).';
      break;
    }
    case 'value-does-not-fit':
      issue.hint =
        'The value is too long for its box even at the smallest font size. Shorten the text, make the box wider or taller, or set multiline to true with a taller box.';
      break;
    case 'unsupported-characters':
      issue.hint =
        'The value has characters the built-in font cannot draw (for example CJK or emoji). Remove or replace them, or assign the field to the human.';
      break;
    default:
      break;
  }
  if (issue.hint !== undefined) issue.hint = issue.hint.replace(/\s+/g, ' ').trim();
  return issue;
}

function toFieldReport(field: ResolvedField): FieldReport {
  return {
    id: field.id,
    type: field.type,
    assignee: field.assignee,
    required: field.required,
    placement: field.placement.kind,
    rect: roundRect(field.rect),
  };
}

/**
 * Check `requestInput` against `pdf`. Request problems are returned in the
 * report; only an unreadable PDF throws (SignPdfError).
 */
export async function validateRequestAgainstPdf(pdf: Uint8Array, requestInput: unknown): Promise<ValidationResult> {
  const inspection = await inspectPdf(pdf, { text: false });
  const report: ValidationReport = {
    ok: false,
    sha256: inspection.sha256,
    pages: inspection.pages,
    fields: [],
    errors: [],
    warnings: [],
  };

  const parsed = safeParseSignRequest(requestInput);
  if (!parsed.success) {
    report.errors = parsed.error.issues.map((issue) => {
      const out: ValidationIssue = {
        code: 'invalid-request',
        message: issue.message,
        path: issue.path.map(String).join('.'),
        hint: 'Compare this part of the request with the JSON Schema (sign-pdf schema, or the get_request_schema tool).',
      };
      const fieldId = issue.path[0] === 'fields' ? fieldIdAt(requestInput, issue.path[1]) : undefined;
      if (fieldId !== undefined) out.fieldId = fieldId;
      return out;
    });
    return { report };
  }
  const request = parsed.data;

  if (request.document.sha256 !== inspection.sha256) {
    report.errors.push({
      code: 'hash-mismatch',
      message: `The PDF does not match the request: document.sha256 is ${request.document.sha256}, but this PDF's SHA-256 is ${inspection.sha256}.`,
      path: 'document.sha256',
      hint: `If this is the right PDF, set document.sha256 to ${inspection.sha256}.`,
    });
    return { report };
  }

  let text: Promise<TextItem[]> | undefined;
  const pdfText = (): Promise<TextItem[]> => {
    text ??= inspectPdf(pdf).then((full) => full.text);
    return text;
  };

  let outcome: ResolveReport;
  try {
    // The request as written, so core can tell an `occurrence` the author gave from the default.
    outcome = await resolveRequestCollect(pdf, requestInput as SignRequestInput);
  } catch (error) {
    if (!(error instanceof SignPdfError)) throw error;
    outcome = { fields: [], errors: [error], warnings: [] };
  }
  for (const error of outcome.errors) report.errors.push(await withHint(error, request, inspection, pdfText));
  const { resolved, fields } = outcome;

  report.fields = fields.map(toFieldReport);
  report.warnings = [...outcome.warnings.map(ambiguityIssue), ...findWarnings(request, fields)];
  report.ok = report.errors.length === 0 && resolved !== undefined;
  return report.ok && resolved ? { report, resolved } : { report };
}

export { anchorCandidatesOf } from './tools.ts';
