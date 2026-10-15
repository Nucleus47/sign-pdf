/**
 * Sign-side state: what the human has entered, what is still missing, and the
 * input handed to finalizeDocument. Pure functions; no DOM.
 */
import {
  HANDOFF_FILE_SUFFIX,
  isSigningField,
  type AuditRecord,
  type Rect,
  type ResolvedField,
  type ResolvedRequest,
  type SignatureMethod,
  type Signer,
} from '@sign-pdf/spec';
import type { HumanInput } from './core.ts';
import { displayText, isPlaceholderName } from './displayText.ts';

/** The exact statement the human accepts. It is stored verbatim in the audit record. */
export const CONSENT_TEXT =
  'I have reviewed this document and every value in it, and I agree to sign it electronically. I am signing it myself, and I intend the signature I add to be my signature.';

export interface CapturedSignature {
  png: Uint8Array;
  method: SignatureMethod;
  /** Object URL of the PNG for on-screen preview; lives for this page session only. */
  previewUrl: string;
}

export interface SignDraft {
  values: Record<string, string | boolean>;
  signatures: Record<string, CapturedSignature>;
  /** Only fields the human moved or resized. */
  rects: Record<string, Rect>;
  /**
   * Human-assigned text and date fields whose request value the human kept
   * ("Keep this value") or edited. Until then the value is only a suggestion.
   */
  reviewed: Record<string, true>;
  signerName: string;
  consent: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar date as YYYY-MM-DD. */
export function localIsoDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** The value a field arrives with in the request, if any. */
export function requestValue(field: ResolvedField): string | boolean | undefined {
  return isSigningField(field) ? undefined : (field as { value?: string | boolean }).value;
}

/**
 * A value the request put on a field that the human must answer. The request
 * is untrusted: such a value is a suggestion, never the human's answer.
 */
export function isSuggestion(field: ResolvedField): boolean {
  if (field.assignee !== 'human') return false;
  const value = requestValue(field);
  // An unticked box is what the human starts with anyway.
  return field.type === 'checkbox' ? value === true : value !== undefined;
}

/** True when the request suggested ticking a checkbox the human must answer. */
export function suggestsTick(field: ResolvedField): boolean {
  return field.type === 'checkbox' && isSuggestion(field);
}

/**
 * A suggested text or date value the human has neither kept nor edited.
 * It is shown, but it does not count and the document cannot be signed.
 */
export function awaitsConfirmation(field: ResolvedField, draft: SignDraft): boolean {
  if (field.type === 'checkbox' || !isSuggestion(field)) return false;
  return draft.reviewed[field.id] !== true;
}

// ---------------------------------------------------------------------------
// Several signers: one turn (pass) per signer, in the request's order, on this device.

/** The request's signers in signing order. Empty for a request with one signer. */
export function signersOf(resolved: ResolvedRequest): readonly Signer[] {
  return resolved.request.signers ?? [];
}

/** How a signer is named on screen: the request's name (untrusted), else "Signer n". */
export function signerLabel(signers: readonly Signer[], pass: number): string {
  return displayText(signers[pass]?.name ?? '').trim() || `Signer ${pass + 1}`;
}

/**
 * Can the signer of this turn fill, move or confirm the field? With one signer,
 * every field. With several, a human field only in its own signer's turn, and
 * an agent field only in the first turn, so one person reviews it.
 */
export function isEditableIn(field: ResolvedField, signers: readonly Signer[], pass: number): boolean {
  if (signers.length === 0) return true;
  if (field.signerId !== undefined) return field.signerId === signers[pass]?.id;
  return pass === 0;
}

/** The turn in which a field is filled or reviewed, or -1 when no turn has it. */
export function passOfField(field: ResolvedField, signers: readonly Signer[]): number {
  if (signers.length === 0) return 0;
  if (field.signerId === undefined) return 0;
  return signers.findIndex((signer) => signer.id === field.signerId);
}

/** The draft for the next turn: the field work stays, the name and confirmation start over. */
export function draftForPass(resolved: ResolvedRequest, draft: SignDraft, pass: number): SignDraft {
  return { ...draft, signerName: signersOf(resolved)[pass]?.name ?? '', consent: false };
}

export function initialDraft(resolved: ResolvedRequest, now: Date): SignDraft {
  const values: Record<string, string | boolean> = {};
  for (const field of resolved.fields) {
    if (isSigningField(field)) continue;
    const value = requestValue(field);
    // A human-assigned checkbox never arrives ticked: only the human ticks it.
    if (field.type === 'checkbox' && field.assignee === 'human') continue;
    if (value !== undefined) values[field.id] = value;
    // The spec: a human date field without a value defaults to the signing day.
    else if (field.type === 'date' && field.assignee === 'human') values[field.id] = localIsoDate(now);
  }
  return {
    values,
    signatures: {},
    rects: {},
    reviewed: {},
    signerName: resolved.request.signers?.[0]?.name ?? resolved.request.signer?.name ?? '',
    consent: false,
  };
}

/** Whitespace, zero-width and control characters alone are not an answer. */
export function isBlankText(value: string): boolean {
  return value.replace(/[\s\p{Cc}\p{Cf}]/gu, '') === '';
}

/**
 * Does this field have what it needs? A suggested value on a human-assigned
 * field does not count until the human keeps or edits it.
 */
export function hasValue(field: ResolvedField, draft: SignDraft): boolean {
  if (isSigningField(field)) return draft.signatures[field.id] !== undefined;
  if (awaitsConfirmation(field, draft)) return false;
  const value = draft.values[field.id];
  switch (field.type) {
    case 'text':
      return typeof value === 'string' && !isBlankText(value);
    case 'date':
      return typeof value === 'string' && ISO_DATE.test(value);
    case 'checkbox':
      // A required checkbox must be ticked. (An optional one never blocks signing.)
      return value === true;
  }
}

export interface RequiredItem {
  key: string;
  /** Plain-language name of what is missing. */
  label: string;
  done: boolean;
  fieldId?: string;
  /**
   * The request already filled it and nothing is asked of the signer. It still
   * blocks signing if it is cleared, but it is left out of the count.
   */
  prefilled?: boolean;
}

const TYPE_NAME: Record<ResolvedField['type'], string> = {
  text: 'Text field',
  date: 'Date field',
  checkbox: 'Checkbox',
  signature: 'Signature',
  initials: 'Initials',
};

/**
 * The field's name for the screen. The label is untrusted text. A missing or
 * placeholder label falls back to the type: the id is for software, not people.
 */
export function fieldName(field: Pick<ResolvedField, 'id' | 'label' | 'type'>): string {
  const label = displayText(field.label ?? '').trim();
  if (label && !isPlaceholderName(label)) return label;
  return TYPE_NAME[field.type];
}

/** The field opens with a value the signer need not confirm: the request's, or today's date. */
function startsFilled(field: ResolvedField): boolean {
  if (isSigningField(field) || isSuggestion(field)) return false;
  if (requestValue(field) !== undefined) return field.type !== 'checkbox' || field.assignee !== 'human';
  return field.type === 'date' && field.assignee === 'human';
}

/** What the signer of turn `pass` must finish. With one signer there is one turn, 0. */
export function requiredItems(resolved: ResolvedRequest, draft: SignDraft, pass = 0): RequiredItem[] {
  const signers = signersOf(resolved);
  // An optional field with a suggested value is listed too: nothing the
  // request suggested is written until the human has kept or changed it.
  const items: RequiredItem[] = resolved.fields
    .filter((field) => isEditableIn(field, signers, pass))
    .filter((field) => field.required || (field.type !== 'checkbox' && isSuggestion(field)))
    .map((field) => ({
      key: `field:${field.id}`,
      label: fieldName(field),
      done: field.required ? hasValue(field, draft) : !awaitsConfirmation(field, draft),
      fieldId: field.id,
      prefilled: startsFilled(field),
    }));
  const requestedName = signers[pass]?.name ?? resolved.request.signer?.name;
  items.push({
    key: 'signer-name',
    label: 'Your name',
    done: draft.signerName.trim() !== '',
    prefilled: Boolean(requestedName?.trim()),
  });
  items.push({ key: 'consent', label: 'The confirmation checkbox', done: draft.consent });
  return items;
}

export interface Progress {
  done: number;
  total: number;
  complete: boolean;
  missing: string[];
}

/** The count covers only what the signer must do: prefilled items are left out of it. */
export function progressOf(items: readonly RequiredItem[]): Progress {
  const missing = items.filter((item) => !item.done).map((item) => item.label);
  const counted = items.filter((item) => !item.prefilled);
  return {
    done: counted.filter((item) => item.done).length,
    total: counted.length,
    complete: missing.length === 0,
    missing,
  };
}

export function progressText(progress: Progress): string {
  return `${progress.done} of ${progress.total} required items done`;
}

export type ValueOrigin = 'prefilled' | 'changed' | 'yours';

/**
 * Where the value on screen came from, for the "prefilled" marker. Every value
 * that came from the request is marked, whoever the field is assigned to. A
 * human-assigned checkbox never shows the request's value, so it is "yours".
 */
export function valueOrigin(field: ResolvedField, draft: SignDraft): ValueOrigin {
  const original = requestValue(field);
  if (original === undefined) return 'yours';
  if (field.type === 'checkbox' && field.assignee === 'human') return 'yours';
  return draft.values[field.id] === original ? 'prefilled' : 'changed';
}

/**
 * The input for finalizeDocument: values the human filled or changed,
 * signatures, and moved rectangles. Untouched prefilled values are left to the
 * request so the audit record can tell them apart. With several signers, the
 * input of turn `pass` carries only the fields that turn can change.
 */
export function buildHumanInput(resolved: ResolvedRequest, draft: SignDraft, now: Date, pass = 0): HumanInput {
  const signers = signersOf(resolved);
  const values: Record<string, string | boolean> = {};
  const signatures: HumanInput['signatures'] = {};
  const confirmed: Record<string, true> = {};
  const rects: Record<string, Rect> = {};
  for (const field of resolved.fields) {
    if (!isEditableIn(field, signers, pass)) continue;
    const rect = draft.rects[field.id];
    if (rect) rects[field.id] = rect;
    // A suggestion the human kept (or ticked). Core records it as confirmed unless the value changed.
    if (isSuggestion(field) && (field.type === 'checkbox' ? draft.values[field.id] === true : draft.reviewed[field.id] === true)) {
      confirmed[field.id] = true;
    }
    if (isSigningField(field)) {
      const captured = draft.signatures[field.id];
      if (captured) signatures[field.id] = { png: captured.png, method: captured.method };
      continue;
    }
    if (field.type === 'checkbox' && field.assignee === 'human' && requestValue(field) !== undefined) {
      // Always the human's own answer: core would otherwise draw the request's tick.
      values[field.id] = draft.values[field.id] === true;
      continue;
    }
    const value = draft.values[field.id];
    if (value === undefined) continue;
    if (valueOrigin(field, draft) === 'prefilled') continue;
    if (typeof value === 'string' && value.trim() === '' && requestValue(field) === undefined) continue;
    if (field.type === 'date' && typeof value === 'string' && !ISO_DATE.test(value)) continue;
    values[field.id] = value;
  }
  const timestamp = now.toISOString();
  const signerId = signers[pass]?.id;
  const input: HumanInput = {
    ...(signerId !== undefined ? { signerId } : {}),
    signerName: draft.signerName.trim(),
    consent: { text: CONSENT_TEXT, acceptedAt: timestamp },
    values,
    signatures,
    signedAt: timestamp,
  };
  if (Object.keys(rects).length > 0) input.rects = rects;
  if (Object.keys(confirmed).length > 0) input.confirmed = confirmed;
  return input;
}

// ---------------------------------------------------------------------------
// Guided signing: the steps one signer walks through, in document order.

/**
 * One step of a turn. `prefilled` is the check of every value the preparer
 * filled (first turn only); `field` is one of the signer's own fields;
 * `finish` is the confirmation and the end-of-turn action.
 */
export type GuideStep =
  | { kind: 'prefilled'; fieldIds: readonly string[] }
  | { kind: 'field'; fieldId: string }
  | { kind: 'finish' };

/** Reading order on paper: page, then top to bottom, then left to right. */
export function byDocumentOrder(a: Pick<ResolvedField, 'rect'>, b: Pick<ResolvedField, 'rect'>): number {
  return a.rect.page - b.rect.page || a.rect.y - b.rect.y || a.rect.x - b.rect.x;
}

/**
 * The steps of turn `pass`: one "check prefilled values" step when the turn
 * reviews agent-filled fields, then each of the signer's own fields in
 * document order (required and optional), then the finish step. Dates that
 * start filled are skipped. The order
 * comes from where the request put the fields, so moving a box does not
 * reorder the walk.
 */
export function guideSteps(resolved: ResolvedRequest, pass = 0): GuideStep[] {
  const signers = signersOf(resolved);
  const editable = resolved.fields.filter((field) => isEditableIn(field, signers, pass)).sort(byDocumentOrder);
  // A date that starts filled (the request's, or today's) is not a step: the
  // signer can still change it from "All fields" or by tapping its box.
  const walked = editable.filter((field) => !(field.type === 'date' && startsFilled(field)));
  const prefilled = walked.filter((field) => field.assignee === 'agent').map((field) => field.id);
  const steps: GuideStep[] = [];
  if (prefilled.length > 0) steps.push({ kind: 'prefilled', fieldIds: prefilled });
  for (const field of walked) {
    if (field.assignee === 'human') steps.push({ kind: 'field', fieldId: field.id });
  }
  steps.push({ kind: 'finish' });
  return steps;
}

/** The index of the step that holds a field, or -1 when this turn has none. */
export function stepOfField(steps: readonly GuideStep[], fieldId: string): number {
  return steps.findIndex(
    (step) =>
      (step.kind === 'field' && step.fieldId === fieldId) ||
      (step.kind === 'prefilled' && step.fieldIds.includes(fieldId)),
  );
}

/** "3 of 16": where a field step sits among the turn's field steps. Null for other steps. */
export function fieldStepPosition(steps: readonly GuideStep[], index: number): { number: number; total: number } | null {
  if (steps[index]?.kind !== 'field') return null;
  const fieldSteps = steps.filter((step) => step.kind === 'field');
  return { number: steps.slice(0, index + 1).filter((step) => step.kind === 'field').length, total: fieldSteps.length };
}

/** Does the field still hold back signing? The same rule requiredItems applies. */
export function isOpen(field: ResolvedField, draft: SignDraft): boolean {
  if (field.required) return !hasValue(field, draft);
  return field.type !== 'checkbox' && awaitsConfirmation(field, draft);
}

/** The first step with a field that still holds back signing, or -1 when none has. */
export function firstOpenStep(steps: readonly GuideStep[], resolved: ResolvedRequest, draft: SignDraft): number {
  const byId = new Map(resolved.fields.map((field) => [field.id, field]));
  return steps.findIndex((step) => {
    const ids = step.kind === 'field' ? [step.fieldId] : step.kind === 'prefilled' ? step.fieldIds : [];
    return ids.some((id) => {
      const field = byId.get(id);
      return field !== undefined && isOpen(field, draft);
    });
  });
}

/**
 * The signature (or initials) this signer already made, offered for another
 * field of the same kind. Only fields of the current turn count, so one
 * signer's signature is never offered to another signer.
 */
export function savedSignatureFor(
  resolved: ResolvedRequest,
  draft: SignDraft,
  fieldId: string,
  pass = 0,
): CapturedSignature | undefined {
  const signers = signersOf(resolved);
  const target = resolved.fields.find((field) => field.id === fieldId);
  if (!target || !isSigningField(target) || !isEditableIn(target, signers, pass)) return undefined;
  return [...resolved.fields]
    .sort(byDocumentOrder)
    .filter((field) => field.type === target.type && field.id !== fieldId && isEditableIn(field, signers, pass))
    .map((field) => draft.signatures[field.id])
    .find((signature) => signature !== undefined);
}

/**
 * What the one floating button does on a step:
 * - `apply`: put the signer's saved signature or initials on this field;
 * - `capture`: open signature capture (the first signature of its kind);
 * - `confirm`: keep the value shown (a suggestion, or the date filled in);
 * - `next`: move on.
 * Each of the first three is one deliberate tap; nothing is applied without it.
 */
export type StepAction = 'apply' | 'capture' | 'confirm' | 'next';

export function stepAction(resolved: ResolvedRequest, draft: SignDraft, step: GuideStep | undefined, pass = 0): StepAction {
  if (step?.kind !== 'field') return 'next';
  const field = resolved.fields.find((item) => item.id === step.fieldId);
  if (!field) return 'next';
  if (isSigningField(field)) {
    if (draft.signatures[field.id]) return 'next';
    return savedSignatureFor(resolved, draft, field.id, pass) ? 'apply' : 'capture';
  }
  if (awaitsConfirmation(field, draft)) return 'confirm';
  // A date the signer has not looked at yet: the day it was filled in with.
  if (field.type === 'date' && draft.reviewed[field.id] !== true && hasValue(field, draft)) return 'confirm';
  return 'next';
}

/**
 * How a turn ends: the last signer signs; an earlier signer finishes their
 * part and hands over. Every end-of-turn button reads its label from here.
 */
export type TurnEnd = { kind: 'sign' } | { kind: 'handoff'; next: string };

export function turnEnd(resolved: ResolvedRequest, pass = 0): TurnEnd {
  const signers = signersOf(resolved);
  if (signers.length === 0 || pass >= signers.length - 1) return { kind: 'sign' };
  return { kind: 'handoff', next: signerLabel(signers, pass + 1) };
}

export function turnEndLabel(end: TurnEnd, signerName: string, busy: boolean): string {
  if (end.kind === 'handoff') return `Download PDF for ${end.next}`;
  if (busy) return 'Signing…';
  return signerName ? `Sign as ${signerName}` : 'Sign';
}

/**
 * The draft for the turn after the passes a hand-off PDF carries: the earlier
 * signers' values, signatures and moves are filled in (their fields stay
 * locked), and the next signer's turn starts fresh. `preview` makes the
 * on-screen image of a signature.
 */
export function draftFromPasses(
  resolved: ResolvedRequest,
  passes: readonly HumanInput[],
  now: Date,
  preview: (png: Uint8Array) => string,
): SignDraft {
  const draft = initialDraft(resolved, now);
  for (const pass of passes) {
    Object.assign(draft.values, pass.values);
    for (const [id, signature] of Object.entries(pass.signatures)) {
      draft.signatures[id] = { png: signature.png, method: signature.method, previewUrl: preview(signature.png) };
    }
    if (pass.rects) Object.assign(draft.rects, pass.rects);
    for (const id of Object.keys(pass.confirmed ?? {})) draft.reviewed[id] = true;
  }
  return draftForPass(resolved, draft, passes.length);
}

/**
 * `contract.pdf`, 1, 2 -> `contract-signed-1-of-2-handoff.pdf`: the name says
 * how many of the signers signed so far. `done` counts this turn too.
 */
export function handoffFileName(originalName: string, done: number, total: number): string {
  const base = originalName.replace(/\.pdf$/i, '').trim() || 'document';
  return `${base}-signed-${done}-of-${total}${HANDOFF_FILE_SUFFIX}`;
}

/** Untrusted text for one line of plain text: no bidi or other control characters, no line breaks. */
export function plainLine(value: string): string {
  return displayText(value)
    .replace(/\p{Cc}+/gu, ' ')
    // Other format characters go, except the joiners some names and emoji need.
    .replace(/(?![\u200c\u200d])\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The message the signer pastes to the next signer, with the hand-off file
 * attached. `address` is the web app's full address, or null on a build that
 * has none another device can open.
 */
export function handoffMessage(next: string, address: string | null, fileName: string): string {
  return [
    `Hi ${plainLine(next)},`,
    'Please sign this document. I have signed my part.',
    `1. Go to ${address ?? 'the sign-pdf web app'}`,
    `2. Choose "Did you receive a file to sign?" and open the attached file: ${plainLine(fileName)}`,
    '3. Sign, then download the signed PDF and send it back to me.',
    'The file opens in your browser. Nothing is uploaded.',
  ].join('\n');
}

/** `contract.pdf` -> `contract-signed.pdf` */
export function signedFileName(originalName: string): string {
  const base = originalName.replace(/\.pdf$/i, '').trim() || 'document';
  return `${base}-signed.pdf`;
}

export interface AuditSummary {
  agentFilled: string[];
  humanFilled: string[];
  humanChanged: string[];
  /** Human-assigned fields that ended with the value the request suggested. */
  humanKept: string[];
  humanMoved: string[];
  signed: string[];
}

/** A problem with one field's value, in plain words, with the way to fix it. */
export function explainValueProblem(code: string, detail: string): string {
  if (code === 'value-does-not-fit') {
    return 'This text is too long for its box. Shorten it, or make the box larger on the page.';
  }
  if (code === 'unsupported-characters') {
    return `Some characters cannot be printed in the PDF: ${detail} Only Latin, Greek and Cyrillic letters can be used.`;
  }
  return `This value cannot be used: ${detail}`;
}

/** Group the audit record's fields the way the signed screen reports them. */
export function summarizeAudit(
  audit: AuditRecord,
  names: ReadonlyMap<string, string> = new Map(),
): AuditSummary {
  const summary: AuditSummary = {
    agentFilled: [],
    humanFilled: [],
    humanChanged: [],
    humanKept: [],
    humanMoved: [],
    signed: [],
  };
  for (const field of audit.fields) {
    const label = displayText(names.get(field.id) ?? field.id);
    if (field.movedByHuman) summary.humanMoved.push(label);
    // Values come from the record: the text as it was drawn, not what was typed.
    const shown =
      typeof field.value === 'boolean'
        ? field.value
          ? 'ticked'
          : 'not ticked'
        : field.value === undefined
          ? undefined
          : displayText(field.value);
    const name = shown === undefined || shown === '' ? label : `${label}: ${shown}`;
    if (field.type === 'signature' || field.type === 'initials') {
      if (field.signatureSha256 !== undefined || field.signatureMethod !== undefined) summary.signed.push(name);
      continue;
    }
    if (field.changedByHuman) summary.humanChanged.push(name);
    else if (field.filledBy === 'agent' && field.assignee === 'human') {
      // Records written before `confirmedByHuman` existed cannot tell a kept suggestion from an
      // untouched one; the sign view only wrote such a value after the human kept it or ticked the box.
      const kept = field.confirmedByHuman ?? (field.value !== undefined && field.value !== '' && field.value !== false);
      if (kept) summary.humanKept.push(name);
      else if (field.confirmedByHuman === false) summary.agentFilled.push(name);
    } else if (field.filledBy === 'agent') summary.agentFilled.push(name);
    else if (field.value !== undefined && field.value !== '') summary.humanFilled.push(name);
  }
  return summary;
}
