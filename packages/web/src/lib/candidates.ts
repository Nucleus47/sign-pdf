/**
 * Numbered places for fields in the Prepare view: the core's placement
 * candidates, numbered per page in reading order, with the rectangle a field
 * placed there gets. Keys 1-9 reach the first nine places on a page; every
 * place is also in a list of buttons. Pure functions; no DOM.
 */
import type { FieldType, PlacementInput, Rect, ResolvedRequest, SignRequestInput } from '@sign-pdf/spec';
import type { PlacementCandidate } from './core.ts';
import { displayText } from './displayText.ts';

export interface Mark {
  /** 1-based, per page, in reading order. */
  number: number;
  page: number;
  kind: PlacementCandidate['kind'];
  /** The label or form field name: untrusted document content. */
  text: string;
  /** The type a field placed here starts as. */
  type: FieldType;
  /** The placement the request keeps for a field placed here. */
  placement: PlacementInput;
  /** Where that placement resolves. */
  target: Rect;
}

const MAX_QUOTED_CHARS = 40;

function quote(text: string): string {
  const clean = displayText(text).replace(/\s+/g, ' ').trim();
  return `“${clean.length > MAX_QUOTED_CHARS ? `${clean.slice(0, MAX_QUOTED_CHARS - 1)}…` : clean}”`;
}

/** What the place is, in words: "after “Signature:”", "line after “Name”", "form field “Date”". */
export function describeMark(mark: Pick<Mark, 'kind' | 'text'>): string {
  switch (mark.kind) {
    case 'label':
      return `after ${quote(mark.text)}`;
    case 'line':
      return /^_+$/.test(mark.text.trim()) ? 'blank line' : `line after ${quote(mark.text)}`;
    case 'widget':
      return `form field ${quote(mark.text)}`;
  }
}

/** The text a person, screen reader or agent reads: "3: after “Signature:”, page 2". */
export function markLabel(mark: Mark): string {
  return `${mark.number}: ${describeMark(mark)}, page ${mark.page}`;
}

const probeId = (index: number): string => `c${index + 1}`;

/** A request with one field per candidate, so the core resolver says where each lands. */
export function probeRequest(
  candidates: readonly PlacementCandidate[],
  document: { name: string; sha256: string },
): SignRequestInput {
  return {
    version: 1,
    document,
    fields: candidates.map((candidate, index) => ({
      id: probeId(index),
      type: candidate.suggested.type ?? 'text',
      assignee: 'human' as const,
      placement: candidate.suggested.placement,
    })),
  };
}

/**
 * Where each candidate's placement lands, or undefined for one the resolver
 * rejects. One request first; if it fails, each candidate on its own.
 */
export async function resolveTargets(
  candidates: readonly PlacementCandidate[],
  document: { name: string; sha256: string },
  resolve: (request: SignRequestInput) => Promise<ResolvedRequest>,
): Promise<(Rect | undefined)[]> {
  if (candidates.length === 0) return [];
  try {
    const resolved = await resolve(probeRequest(candidates, document));
    return candidates.map((_, index) => resolved.fields.find((field) => field.id === probeId(index))?.rect);
  } catch {
    return Promise.all(
      candidates.map(async (candidate) => {
        try {
          return (await resolve(probeRequest([candidate], document))).fields[0]?.rect;
        } catch {
          return undefined;
        }
      }),
    );
  }
}

/** Number the candidates that resolved, per page. */
export function numberMarks(
  candidates: readonly PlacementCandidate[],
  targets: readonly (Rect | undefined)[],
): Mark[] {
  const perPage = new Map<number, number>();
  const marks: Mark[] = [];
  candidates.forEach((candidate, index) => {
    const target = targets[index];
    if (!target) return;
    const number = (perPage.get(target.page) ?? 0) + 1;
    perPage.set(target.page, number);
    marks.push({
      number,
      page: target.page,
      kind: candidate.kind,
      text: candidate.text,
      type: candidate.suggested.type ?? 'text',
      placement: candidate.suggested.placement,
      target,
    });
  });
  return marks;
}

export function markAt(marks: readonly Mark[], page: number, number: number): Mark | undefined {
  return marks.find((mark) => mark.page === page && mark.number === number);
}

export const sameMark = (a: Mark, b: Mark): boolean => a.page === b.page && a.number === b.number;
