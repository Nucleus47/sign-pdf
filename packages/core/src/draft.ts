import { safeParseSignRequest, type FieldInput, type Signer, type SignRequestInput } from '@sign-pdf/spec';
import type { PlacementCandidate } from './candidates.ts';
import { SignPdfError } from './errors.ts';
import type { PdfInspection } from './index.ts';

export interface BuildDraftRequestOptions {
  /** 1-based candidate numbers. Defaults to every candidate, in reading order. */
  candidateNumbers?: readonly number[];
  /** Values keyed by candidate number (as a string) or generated field id. */
  values?: Readonly<Record<string, string | boolean>>;
  title?: string;
  /** Expected name for the single-signer request form. */
  signerName?: string;
  /** Human signers; human fields are assigned to these in candidate order, cycling as needed. */
  signers?: Signer[];
  /** The inspection has no source filename. Defaults to `document.pdf`. */
  documentName?: string;
}

interface DraftField {
  number: number;
  candidate: PlacementCandidate;
  id: string;
}

function draftError(message: string, hint: string): SignPdfError {
  return new SignPdfError('invalid-argument', message, undefined, hint);
}

function fieldIdBase(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/g, '');
  if (slug.length === 0) return 'field';
  return /^[a-z]/.test(slug) ? slug : `field_${slug}`.slice(0, 64);
}

function uniqueFieldId(label: string, used: Set<string>, counts: Map<string, number>): string {
  const base = fieldIdBase(label) || 'field';
  let suffix = counts.get(base) ?? 1;
  let id = suffix === 1 ? base : `${base.slice(0, 62)}_${suffix}`;
  while (used.has(id)) {
    suffix++;
    id = `${base.slice(0, 62)}_${suffix}`;
  }
  counts.set(base, suffix + 1);
  used.add(id);
  return id;
}

function chooseFields(candidates: readonly PlacementCandidate[], requested?: readonly number[]): DraftField[] {
  if (candidates.length === 0) {
    throw draftError('There are no placement candidates to draft.', 'Run find_candidates on an inspection that contains usable text or visible form widgets.');
  }
  const numbers = requested ?? candidates.map((_candidate, index) => index + 1);
  if (numbers.length === 0) {
    throw draftError('No candidates were selected.', 'Select at least one candidate number, or omit candidateNumbers to use all candidates.');
  }
  const selected = new Set<number>();
  for (const number of numbers) {
    if (!Number.isInteger(number) || number < 1 || number > candidates.length) {
      throw draftError(
        `Candidate number ${String(number)} is not available; this result has ${candidates.length} candidate(s).`,
        `Use a whole number from 1 to ${candidates.length}, based on the candidate result's reading order.`,
      );
    }
    if (selected.has(number)) {
      throw draftError(`Candidate number ${number} was selected more than once.`, 'List each candidate number once.');
    }
    selected.add(number);
  }

  const used = new Set<string>();
  const counts = new Map<string, number>();
  return candidates.flatMap((candidate, index) => {
    const number = index + 1;
    return selected.has(number) ? [{ number, candidate, id: uniqueFieldId(candidate.text, used, counts) }] : [];
  });
}

function valuesByCandidate(
  fields: readonly DraftField[],
  values: Readonly<Record<string, string | boolean>> | undefined,
): Map<number, string | boolean> {
  const byNumber = new Map(fields.map((field) => [field.number, field]));
  const byId = new Map(fields.map((field) => [field.id, field]));
  const result = new Map<number, string | boolean>();
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw draftError(`The value for ${JSON.stringify(key)} must be a string or boolean.`, 'Pass a string or boolean value for each selected candidate.');
    }
    const field = /^\d+$/.test(key) ? byNumber.get(Number(key)) : byId.get(key);
    if (!field) {
      throw draftError(`The value key ${JSON.stringify(key)} does not identify a selected candidate or draft field id.`, 'Use a selected candidate number or one of the generated field ids.');
    }
    if (result.has(field.number)) {
      throw draftError(`Candidate ${field.number} has more than one supplied value.`, 'Supply a value by candidate number or by field id, but not both.');
    }
    if (field.candidate.suggested.type === 'signature' || field.candidate.suggested.type === 'initials') {
      throw draftError(
        `Candidate ${field.number} is a ${field.candidate.suggested.type} field and cannot have a supplied value.`,
        'Only the human signer can provide a signature or initials, in the signing view. Remove this value entry.',
      );
    }
    result.set(field.number, value);
  }
  return result;
}

/**
 * Turn selected candidate suggestions into one sign request. Suggested
 * placements are copied unchanged, including anchors and AcroForm placements.
 * Signature and initials fields always belong to a human. A supplied value
 * makes any other field agent-assigned; fields without values belong to a
 * human. With `signers`, human fields cycle through signers in candidate order.
 */
export function buildDraftRequest(
  inspection: PdfInspection,
  candidates: readonly PlacementCandidate[],
  options: BuildDraftRequestOptions = {},
): SignRequestInput {
  if (options.signerName !== undefined && options.signers !== undefined) {
    throw draftError('Use signerName or signers, not both.', 'Set signerName for one expected signer, or pass signers for an ordered signer list.');
  }

  const fields = chooseFields(candidates, options.candidateNumbers);
  const values = valuesByCandidate(fields, options.values);
  const signers = options.signers;
  if (signers !== undefined && signers.length === 0) {
    throw draftError('The signers list is empty.', 'Pass at least one signer, or omit signers.');
  }

  let humanFieldIndex = 0;
  const request: SignRequestInput = {
    version: 1,
    document: {
      name: options.documentName ?? 'document.pdf',
      sha256: inspection.sha256,
    },
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.signerName !== undefined ? { signer: { name: options.signerName } } : {}),
    ...(signers !== undefined ? { signers: signers.map((signer) => ({ ...signer })) } : {}),
    fields: fields.map(({ number, candidate, id }): FieldInput => {
      const type = candidate.suggested.type ?? 'text';
      const value = values.get(number);
      const assignee = type === 'signature' || type === 'initials' || value === undefined ? 'human' : 'agent';
      const signerId = assignee === 'human' && signers !== undefined
        ? signers[humanFieldIndex++ % signers.length]?.id
        : undefined;
      return {
        id,
        label: candidate.text.slice(0, 200),
        type,
        assignee,
        placement: { ...candidate.suggested.placement },
        ...(signerId !== undefined ? { signerId } : {}),
        ...(value !== undefined ? { value } : {}),
      } as FieldInput;
    }),
  };

  const parsed = safeParseSignRequest(request);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw draftError(
      `The draft options or candidates do not produce a valid sign request: ${details}`,
      'Check the supplied title, documentName, signer options, candidate types, and values against the sign request schema.',
    );
  }
  return request;
}
