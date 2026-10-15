import { describe, expect, it } from 'vitest';
import { FIELDS, makeAudit, makeResolved, makeTwoSignerResolved, PNG_BYTES, TWO_SIGNER_FIELDS } from '../testing/fixtures.ts';
import type { ResolvedField } from '@sign-pdf/spec';
import {
  awaitsConfirmation,
  buildHumanInput,
  CONSENT_TEXT,
  draftForPass,
  draftFromPasses,
  fieldName,
  fieldStepPosition,
  firstOpenStep,
  guideSteps,
  handoffFileName,
  handoffMessage,
  hasValue,
  initialDraft,
  isEditableIn,
  localIsoDate,
  passOfField,
  plainLine,
  progressOf,
  progressText,
  requiredItems,
  savedSignatureFor,
  signedFileName,
  signerLabel,
  signersOf,
  stepAction,
  stepOfField,
  summarizeAudit,
  turnEnd,
  turnEndLabel,
  valueOrigin,
  type SignDraft,
} from './signing.ts';

const now = new Date(2026, 0, 2, 23, 30); // local time, late evening

describe('several signers', () => {
  const two = makeTwoSignerResolved();
  const signers = signersOf(two);
  const byId = (id: string) => TWO_SIGNER_FIELDS.find((item) => item.id === id) as ResolvedField;
  const signature = { png: PNG_BYTES, method: 'drawn' as const, previewUrl: 'blob:test' };

  it('opens the first turn with the first signer’s name', () => {
    expect(initialDraft(two, now).signerName).toBe('Signer One');
    expect(signerLabel(signers, 1)).toBe('Signer Two');
    expect(signerLabel([{ id: 'x' }], 0)).toBe('Signer 1');
  });

  it('lets each turn edit only its own fields, and agent fields only in the first turn', () => {
    expect(isEditableIn(byId('company'), signers, 0)).toBe(true);
    expect(isEditableIn(byId('company'), signers, 1)).toBe(false);
    expect(isEditableIn(byId('sigA'), signers, 0)).toBe(true);
    expect(isEditableIn(byId('sigA'), signers, 1)).toBe(false);
    expect(isEditableIn(byId('sigB'), signers, 0)).toBe(false);
    expect(isEditableIn(byId('sigB'), signers, 1)).toBe(true);
    expect(passOfField(byId('noteB'), signers)).toBe(1);
    // One signer: every field, every time.
    expect(isEditableIn(byId('sigB'), [], 0)).toBe(true);
  });

  it('counts only the current turn’s items', () => {
    const draft = initialDraft(two, now);
    expect(requiredItems(two, draft, 0).map((item) => item.key)).toEqual([
      'field:company',
      'field:sigA',
      'field:dateA',
      'signer-name',
      'consent',
    ]);
    expect(requiredItems(two, draft, 1).map((item) => item.key)).toEqual(['field:sigB', 'signer-name', 'consent']);
  });

  it('builds each turn’s input from its own fields only, with its signer id', () => {
    const draft: SignDraft = {
      ...initialDraft(two, now),
      values: { company: 'Example Company Ltd', dateA: '2026-01-02', noteB: 'From the second signer' },
      signatures: { sigA: signature, sigB: signature },
      rects: { sigA: { page: 1, x: 80, y: 300, width: 180, height: 44 }, sigB: { page: 1, x: 90, y: 400, width: 180, height: 44 } },
      consent: true,
    };
    const first = buildHumanInput(two, draft, now, 0);
    expect(first.signerId).toBe('a');
    expect(first.signerName).toBe('Signer One');
    expect(Object.keys(first.signatures)).toEqual(['sigA']);
    expect(first.values).toEqual({ dateA: '2026-01-02' });
    expect(Object.keys(first.rects ?? {})).toEqual(['sigA']);

    const second = buildHumanInput(two, { ...draftForPass(two, draft, 1), consent: true }, now, 1);
    expect(second.signerId).toBe('b');
    expect(second.signerName).toBe('Signer Two');
    expect(Object.keys(second.signatures)).toEqual(['sigB']);
    expect(second.values).toEqual({ noteB: 'From the second signer' });
    expect(Object.keys(second.rects ?? {})).toEqual(['sigB']);
  });

  it('starts the next turn with the field work kept and a fresh name and confirmation', () => {
    const draft: SignDraft = { ...initialDraft(two, now), signatures: { sigA: signature }, signerName: 'Typed Name', consent: true };
    const next = draftForPass(two, draft, 1);
    expect(next.signatures).toEqual({ sigA: signature });
    expect(next.signerName).toBe('Signer Two');
    expect(next.consent).toBe(false);
  });

  it('keeps one-signer input without a signer id', () => {
    expect(buildHumanInput(resolved, completeDraft(), now)).not.toHaveProperty('signerId');
  });
});
const resolved = makeResolved();
const field = (id: string) => {
  const found = FIELDS.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};

function completeDraft(): SignDraft {
  const draft = initialDraft(resolved, now);
  return {
    ...draft,
    values: { ...draft.values, title: 'Director', agree: true },
    signatures: { signature: { png: PNG_BYTES, method: 'drawn', previewUrl: 'blob:test' } },
    signerName: 'Test Signer',
    consent: true,
  };
}

describe('initial draft', () => {
  it('starts from the prefilled values and the signer name in the request', () => {
    const draft = initialDraft(makeResolved(FIELDS, { signer: { name: 'Test Signer' } }), now);
    expect(draft.values.company).toBe('Example Company Ltd');
    expect(draft.signerName).toBe('Test Signer');
    expect(draft.consent).toBe(false);
    expect(draft.signatures).toEqual({});
  });

  it("defaults a human date field to the signer's local day", () => {
    expect(localIsoDate(now)).toBe('2026-01-02');
    expect(initialDraft(resolved, now).values.signed_on).toBe('2026-01-02');
  });
});

describe('required-items gating', () => {
  it('counts every required field plus the signer name and the consent box', () => {
    const items = requiredItems(resolved, initialDraft(resolved, now));
    expect(items.map((item) => item.key)).toEqual([
      'field:company',
      'field:title',
      'field:agree',
      'field:signed_on',
      'field:signature',
      'signer-name',
      'consent',
    ]);
    const progress = progressOf(items);
    // The defaulted date is left out of the count: nothing is asked of the signer.
    expect(progress).toMatchObject({ done: 0, total: 5, complete: false });
    expect(progress.missing).toEqual([
      'Your job title',
      'I have authority to sign',
      'Signature',
      'Your name',
      'The confirmation checkbox',
    ]);
    expect(progressText(progress)).toBe('0 of 5 required items done');
  });

  it('still blocks signing when a field that started filled is cleared', () => {
    const draft = initialDraft(resolved, now);
    const cleared = { ...draft, values: { ...draft.values, signed_on: '' } };
    const before = progressOf(requiredItems(resolved, draft));
    const after = progressOf(requiredItems(resolved, cleared));
    expect(after.total).toBe(before.total);
    expect(after.missing).toContain(fieldName(resolved.fields.find((field) => field.id === 'signed_on')!));
  });

  it('is complete only when everything required is done', () => {
    const draft = completeDraft();
    expect(progressOf(requiredItems(resolved, draft)).complete).toBe(true);
    for (const broken of [
      { ...draft, consent: false },
      { ...draft, signerName: '   ' },
      { ...draft, signatures: {} },
      { ...draft, values: { ...draft.values, title: '' } },
      { ...draft, values: { ...draft.values, company: '' } },
      { ...draft, values: { ...draft.values, agree: false } },
      { ...draft, values: { ...draft.values, signed_on: '' } },
    ]) {
      expect(progressOf(requiredItems(resolved, broken)).complete).toBe(false);
    }
  });

  it('does not accept whitespace, zero-width or control characters as an answer', () => {
    const draft = completeDraft();
    for (const blank of ['   ', '\t\n', '​‍', '\u0000\u0007', '﻿ ']) {
      expect(hasValue(field('title'), { ...draft, values: { ...draft.values, title: blank } })).toBe(false);
    }
  });

  it('requires a required checkbox to be ticked', () => {
    const draft = completeDraft();
    expect(hasValue(field('agree'), draft)).toBe(true);
    expect(hasValue(field('agree'), { ...draft, values: { ...draft.values, agree: false } })).toBe(false);
  });

  it('ignores optional fields', () => {
    const items = requiredItems(resolved, completeDraft());
    expect(items.some((item) => item.fieldId === 'nickname')).toBe(false);
  });
});

describe('value origin', () => {
  it('marks an untouched agent value as prefilled and an edited one as changed', () => {
    const draft = initialDraft(resolved, now);
    expect(valueOrigin(field('company'), draft)).toBe('prefilled');
    expect(valueOrigin(field('company'), { ...draft, values: { ...draft.values, company: 'Other Ltd' } })).toBe('changed');
    expect(valueOrigin(field('title'), draft)).toBe('yours');
  });
});

describe('consent statement', () => {
  it('covers consent to sign electronically and intent to sign', () => {
    expect(CONSENT_TEXT).toContain('I agree to sign it electronically.');
    expect(CONSENT_TEXT).toContain('I intend the signature I add to be my signature.');
  });
});

describe('input for finalizeDocument', () => {
  it('sends what the human filled or changed, not untouched prefilled values', () => {
    const input = buildHumanInput(resolved, completeDraft(), now);
    expect(input.values).toEqual({ title: 'Director', agree: true, signed_on: '2026-01-02' });
    expect(input.signatures).toEqual({ signature: { png: PNG_BYTES, method: 'drawn' } });
    expect(input.signerName).toBe('Test Signer');
    expect(input.consent).toEqual({ text: CONSENT_TEXT, acceptedAt: now.toISOString() });
    expect(input.signedAt).toBe(now.toISOString());
    expect(input.rects).toBeUndefined();
  });

  it('sends a changed prefilled value, and an empty string when the human cleared it', () => {
    const draft = completeDraft();
    const changed = buildHumanInput(resolved, { ...draft, values: { ...draft.values, company: 'Other Ltd' } }, now);
    expect(changed.values.company).toBe('Other Ltd');
    const cleared = buildHumanInput(resolved, { ...draft, values: { ...draft.values, company: '' } }, now);
    expect(cleared.values.company).toBe('');
  });

  it('leaves out an optional field the human left empty', () => {
    const draft = completeDraft();
    const input = buildHumanInput(resolved, { ...draft, values: { ...draft.values, nickname: '' } }, now);
    expect('nickname' in input.values).toBe(false);
  });

  it('sends moved rectangles only for moved fields', () => {
    const rect = { page: 1, x: 80, y: 262, width: 180, height: 44 };
    const input = buildHumanInput(resolved, { ...completeDraft(), rects: { signature: rect } }, now);
    expect(input.rects).toEqual({ signature: rect });
  });
});

describe('helpers', () => {
  it('names the signed file after the original', () => {
    expect(signedFileName('contract.pdf')).toBe('contract-signed.pdf');
    expect(signedFileName('Contract.PDF')).toBe('Contract-signed.pdf');
    expect(signedFileName('scan')).toBe('scan-signed.pdf');
  });

  it('groups the audit record for the signed screen', () => {
    const rect = { page: 1, x: 0, y: 0, width: 10, height: 10 };
    const audit = {
      ...makeAudit(),
      fields: [
        { id: 'company', type: 'text' as const, assignee: 'agent' as const, filledBy: 'agent' as const, changedByHuman: false, movedByHuman: false, rect, value: 'Example' },
        { id: 'address', type: 'text' as const, assignee: 'agent' as const, filledBy: 'human' as const, changedByHuman: true, movedByHuman: true, rect, value: 'Changed' },
        { id: 'title', type: 'text' as const, assignee: 'human' as const, filledBy: 'human' as const, changedByHuman: false, movedByHuman: false, rect, value: 'Director' },
        { id: 'signature', type: 'signature' as const, assignee: 'human' as const, filledBy: 'human' as const, changedByHuman: false, movedByHuman: false, rect, signatureMethod: 'drawn' as const, signatureSha256: 'b'.repeat(64) },
      ],
    };
    expect(summarizeAudit(audit, new Map([['company', 'Company name']]))).toEqual({
      agentFilled: ['Company name: Example'],
      humanFilled: ['title: Director'],
      humanChanged: ['address: Changed'],
      humanKept: [],
      humanMoved: ['address'],
      signed: ['signature'],
    });
  });
});

describe('request values on human-assigned fields', () => {
  const rect = { page: 1, x: 72, y: 300, width: 180, height: 18 };
  const placement = { kind: 'rect' as const, ...rect };
  const suggested: ResolvedField[] = [
    { id: 'h_text', type: 'text', label: 'Job title', assignee: 'human', required: true, value: 'Director', placement, rect },
    { id: 'h_date', type: 'date', label: 'Start date', assignee: 'human', required: true, value: '2026-03-04', placement, rect },
    { id: 'h_check', type: 'checkbox', label: 'I agree', assignee: 'human', required: true, value: true, placement, rect },
    { id: 'h_opt', type: 'text', label: 'Nickname', assignee: 'human', required: false, value: 'Sam', placement, rect },
    { id: 'a_text', type: 'text', label: 'Company', assignee: 'agent', required: true, value: 'Example Company Ltd', placement, rect },
  ];
  const request = makeResolved(suggested);
  const byId = (id: string) => suggested.find((item) => item.id === id) as ResolvedField;
  const start = () => ({ ...initialDraft(request, now), signerName: 'Test Signer', consent: true });
  const doneOf = (draft: SignDraft) =>
    Object.fromEntries(requiredItems(request, draft).map((item) => [item.fieldId ?? item.key, item.done]));

  it('never pre-satisfies a required human item', () => {
    const draft = start();
    expect(draft.values.h_check).toBeUndefined();
    expect(draft.values.h_text).toBe('Director');
    expect(doneOf(draft)).toMatchObject({ h_text: false, h_date: false, h_check: false, h_opt: false, a_text: true });
    expect(progressOf(requiredItems(request, draft)).complete).toBe(false);
    expect(awaitsConfirmation(byId('h_text'), draft)).toBe(true);
    expect(awaitsConfirmation(byId('a_text'), draft)).toBe(false);
  });

  it('marks every request value as prefilled, whoever the field is assigned to', () => {
    const draft = start();
    expect(valueOrigin(byId('h_text'), draft)).toBe('prefilled');
    expect(valueOrigin(byId('h_date'), draft)).toBe('prefilled');
    expect(valueOrigin(byId('a_text'), draft)).toBe('prefilled');
    // The checkbox does not show the request's value at all.
    expect(valueOrigin(byId('h_check'), draft)).toBe('yours');
    const edited = { ...draft, values: { ...draft.values, h_text: 'Manager' }, reviewed: { h_text: true as const } };
    expect(valueOrigin(byId('h_text'), edited)).toBe('changed');
  });

  it('counts a suggestion once it is kept or edited, and a checkbox once the human ticks it', () => {
    const draft = start();
    const kept: SignDraft = { ...draft, reviewed: { h_text: true, h_date: true, h_opt: true } };
    expect(doneOf(kept)).toMatchObject({ h_text: true, h_date: true, h_opt: true, h_check: false });
    const ticked: SignDraft = { ...kept, values: { ...kept.values, h_check: true } };
    expect(progressOf(requiredItems(request, ticked)).complete).toBe(true);
  });

  it('sends the human\'s own checkbox answer so the request cannot tick the box', () => {
    const draft: SignDraft = { ...start(), reviewed: { h_text: true, h_date: true, h_opt: true } };
    expect(buildHumanInput(request, draft, now).values).toEqual({ h_check: false });
    const ticked = { ...draft, values: { ...draft.values, h_check: true, h_text: 'Manager' } };
    expect(buildHumanInput(request, ticked, now).values).toEqual({ h_check: true, h_text: 'Manager' });
  });

  it('tells core which suggestions the human kept or ticked', () => {
    const draft = start();
    expect(buildHumanInput(request, draft, now).confirmed).toBeUndefined();
    const reviewed: SignDraft = {
      ...draft,
      reviewed: { h_text: true, h_date: true },
      values: { ...draft.values, h_check: true, h_text: 'Manager' },
    };
    // An edited suggestion is listed too; core records it as changed, not confirmed.
    expect(buildHumanInput(request, reviewed, now).confirmed).toEqual({ h_text: true, h_date: true, h_check: true });
  });

  it('reads confirmedByHuman when the record has it', () => {
    const base = { changedByHuman: false, movedByHuman: false, rect };
    const human = { type: 'text' as const, assignee: 'human' as const, filledBy: 'agent' as const };
    const audit = {
      ...makeAudit(),
      fields: [
        { ...base, ...human, id: 'kept', value: 'Director', confirmedByHuman: true },
        { ...base, ...human, id: 'unreviewed', value: 'Manager', confirmedByHuman: false },
      ],
    };
    const summary = summarizeAudit(audit);
    expect(summary.humanKept).toEqual(['kept: Director']);
    expect(summary.agentFilled).toEqual(['unreviewed: Manager']);
  });

  it('reports a kept suggestion apart from an agent-assigned prefilled value', () => {
    const base = { changedByHuman: false, movedByHuman: false, rect };
    const audit = {
      ...makeAudit(),
      fields: [
        { ...base, id: 'h_text', type: 'text' as const, assignee: 'human' as const, filledBy: 'agent' as const, value: 'Director' },
        { ...base, id: 'h_check', type: 'checkbox' as const, assignee: 'human' as const, filledBy: 'agent' as const, value: true },
        { ...base, id: 'a_text', type: 'text' as const, assignee: 'agent' as const, filledBy: 'agent' as const, value: 'Example' },
      ],
    };
    const summary = summarizeAudit(audit);
    expect(summary.humanKept).toEqual(['h_text: Director', 'h_check: ticked']);
    expect(summary.agentFilled).toEqual(['a_text: Example']);
  });
});

describe('guided steps', () => {
  const signature = { png: PNG_BYTES, method: 'drawn' as const, previewUrl: 'blob:test' };
  const box = (id: string, type: ResolvedField['type'], page: number, y: number, x = 72, extra: Partial<ResolvedField> = {}) =>
    ({
      id,
      type,
      label: id,
      assignee: 'human',
      required: true,
      placement: { kind: 'rect', page, x, y, width: 100, height: 20 },
      rect: { page, x, y, width: 100, height: 20 },
      ...extra,
    }) as ResolvedField;

  it('orders the fields as they read on paper: page, then top to bottom, then left to right', () => {
    const resolved = makeResolved([
      box('p2', 'text', 2, 50),
      box('right', 'text', 1, 300, 400),
      box('left', 'text', 1, 300, 72),
      box('top', 'text', 1, 100),
    ]);
    expect(guideSteps(resolved)).toEqual([
      { kind: 'field', fieldId: 'top' },
      { kind: 'field', fieldId: 'left' },
      { kind: 'field', fieldId: 'right' },
      { kind: 'field', fieldId: 'p2' },
      { kind: 'finish' },
    ]);
  });

  it('puts the prefilled values first as one step, and lists optional fields too', () => {
    const steps = guideSteps(makeResolved());
    expect(steps).toEqual([
      { kind: 'prefilled', fieldIds: ['company'] },
      { kind: 'field', fieldId: 'title' },
      { kind: 'field', fieldId: 'nickname' },
      { kind: 'field', fieldId: 'agree' },
      { kind: 'field', fieldId: 'signature' },
      { kind: 'finish' },
    ]);
    expect(stepOfField(steps, 'company')).toBe(0);
    expect(stepOfField(steps, 'agree')).toBe(3);
    // The date starts with today: no step asks the signer to confirm it.
    expect(stepOfField(steps, 'signed_on')).toBe(-1);
    expect(stepOfField(steps, 'missing')).toBe(-1);
    expect(fieldStepPosition(steps, 1)).toEqual({ number: 1, total: 4 });
    expect(fieldStepPosition(steps, 4)).toEqual({ number: 4, total: 4 });
    expect(fieldStepPosition(steps, 0)).toBeNull();
    expect(fieldStepPosition(steps, 5)).toBeNull();
  });

  it('gives each signer only their own fields, and the prefilled check only to the first', () => {
    const two = makeTwoSignerResolved();
    expect(guideSteps(two, 0)).toEqual([
      { kind: 'prefilled', fieldIds: ['company'] },
      { kind: 'field', fieldId: 'sigA' },
      { kind: 'finish' },
    ]);
    expect(guideSteps(two, 1)).toEqual([
      { kind: 'field', fieldId: 'sigB' },
      { kind: 'field', fieldId: 'noteB' },
      { kind: 'finish' },
    ]);
  });

  it('finds the first step that still holds back signing', () => {
    const resolved = makeResolved();
    const steps = guideSteps(resolved);
    const draft = initialDraft(resolved, now);
    expect(firstOpenStep(steps, resolved, draft)).toBe(1);
    const filled: SignDraft = {
      ...draft,
      values: { ...draft.values, title: 'Director', agree: true },
      signatures: { signature },
    };
    expect(firstOpenStep(steps, resolved, filled)).toBe(-1);
    // An optional field with a suggestion holds signing back until it is kept.
    const suggested = makeResolved(FIELDS.map((field) => (field.id === 'nickname' ? { ...field, value: 'Sam' } : field)) as ResolvedField[]);
    const suggestedDraft = { ...filled, values: { ...filled.values, nickname: 'Sam' } };
    expect(firstOpenStep(guideSteps(suggested), suggested, suggestedDraft)).toBe(2);
  });

  it('chooses what the floating button does on each step', () => {
    const resolved = makeResolved([
      box('sig1', 'signature', 1, 100),
      box('sig2', 'signature', 1, 200),
      box('ini1', 'initials', 1, 300),
      box('when', 'date', 1, 400),
      box('note', 'text', 1, 500, 72, { value: 'suggested' } as Partial<ResolvedField>),
      box('free', 'text', 1, 600),
    ]);
    const steps = guideSteps(resolved);
    const at = (id: string) => steps[stepOfField(steps, id)];
    let draft = initialDraft(resolved, now);
    expect(stepAction(resolved, draft, at('sig1'))).toBe('capture');
    expect(stepAction(resolved, draft, at('sig2'))).toBe('capture');
    draft = { ...draft, signatures: { sig1: signature } };
    expect(stepAction(resolved, draft, at('sig1'))).toBe('next');
    expect(stepAction(resolved, draft, at('sig2'))).toBe('apply');
    // Initials never take the signature.
    expect(stepAction(resolved, draft, at('ini1'))).toBe('capture');
    expect(savedSignatureFor(resolved, draft, 'ini1')).toBeUndefined();
    expect(savedSignatureFor(resolved, draft, 'sig2')).toBe(signature);
    // Today's date is no step at all. A suggested value is confirmed with one tap; then the button moves on.
    expect(stepOfField(steps, 'when')).toBe(-1);
    expect(stepAction(resolved, draft, at('note'))).toBe('confirm');
    draft = { ...draft, reviewed: { note: true } };
    expect(stepAction(resolved, draft, at('note'))).toBe('next');
    expect(stepAction(resolved, draft, at('free'))).toBe('next');
    expect(stepAction(resolved, draft, { kind: 'finish' })).toBe('next');
  });

  it('never offers one signer’s signature to another signer', () => {
    const two = makeTwoSignerResolved();
    const draft = { ...initialDraft(two, now), signatures: { sigA: signature } };
    expect(savedSignatureFor(two, draft, 'sigB', 1)).toBeUndefined();
    expect(stepAction(two, draft, { kind: 'field', fieldId: 'sigB' }, 1)).toBe('capture');
    // Not even in the first signer's turn: sigB is not theirs.
    expect(savedSignatureFor(two, draft, 'sigB', 0)).toBeUndefined();
  });

  it('names the end of each turn in one place', () => {
    const two = makeTwoSignerResolved();
    expect(turnEnd(two, 0)).toEqual({ kind: 'handoff', next: 'Signer Two' });
    expect(turnEnd(two, 1)).toEqual({ kind: 'sign' });
    expect(turnEnd(makeResolved())).toEqual({ kind: 'sign' });
    expect(turnEndLabel({ kind: 'handoff', next: 'Signer Two' }, 'Signer One', false)).toBe('Download PDF for Signer Two');
    expect(turnEndLabel({ kind: 'sign' }, 'Test Signer', false)).toBe('Sign as Test Signer');
    expect(turnEndLabel({ kind: 'sign' }, '', false)).toBe('Sign');
    expect(turnEndLabel({ kind: 'sign' }, 'Test Signer', true)).toBe('Signing…');
  });
});

describe('field names', () => {
  it('never shows a placeholder name such as "undefined"', () => {
    expect(fieldName({ id: 'f1', label: 'undefined', type: 'text' })).toBe('Text field');
    expect(fieldName({ id: 'undefined', label: 'undefined', type: 'text' })).toBe('Text field');
    expect(fieldName({ id: 'null', type: 'date' })).toBe('Date field');
    expect(fieldName({ id: 'x', label: ' Name ', type: 'text' })).toBe('Name');
    expect(fieldName({ id: 'x', label: 'Undefined terms', type: 'text' })).toBe('Undefined terms');
  });
});

describe('hand-off between devices', () => {
  const two = makeTwoSignerResolved();
  const png = new Uint8Array([1, 2, 3]);
  const passA = {
    signerId: 'a',
    signerName: 'Signer One',
    consent: { text: CONSENT_TEXT, acceptedAt: '2026-01-02T03:04:05.000Z' },
    signedAt: '2026-01-02T03:04:05.000Z',
    values: { dateA: '2026-01-02' },
    signatures: { sigA: { png, method: 'typed' as const } },
    rects: { dateA: { page: 1, x: 80, y: 350, width: 90, height: 18 } },
  };

  it('starts the next turn with the earlier turns filled in', () => {
    const previews: Uint8Array[] = [];
    const draft = draftFromPasses(two, [passA], now, (bytes) => {
      previews.push(bytes);
      return 'blob:a';
    });
    expect(draft.values.dateA).toBe('2026-01-02');
    expect(draft.signatures.sigA).toEqual({ png, method: 'typed', previewUrl: 'blob:a' });
    expect(draft.rects.dateA?.x).toBe(80);
    expect(previews).toEqual([png]);
    // The next signer's name and a fresh confirmation.
    expect(draft.signerName).toBe('Signer Two');
    expect(draft.consent).toBe(false);
    // The second signer's own input carries none of the first signer's fields.
    const input = buildHumanInput(two, draft, now, 1);
    expect(input.signerId).toBe('b');
    expect(Object.keys(input.signatures)).toEqual([]);
    expect(input.values).not.toHaveProperty('dateA');
  });

  it('names the hand-off file with the stage', () => {
    expect(handoffFileName('contract.pdf', 1, 2)).toBe('contract-signed-1-of-2-handoff.pdf');
    expect(handoffFileName('.pdf', 2, 3)).toBe('document-signed-2-of-3-handoff.pdf');
  });

  it('writes the message for the next signer as plain text, with the name on one line', () => {
    const text = handoffMessage('Signer\nTwo\u202e\u0007', 'https://sign.example.org', 'contract-signed-1-of-2-handoff.pdf');
    expect(text).toBe(
      [
        'Hi Signer Two,',
        'Please sign this document. I have signed my part.',
        '1. Go to https://sign.example.org',
        '2. Choose "Did you receive a file to sign?" and open the attached file: contract-signed-1-of-2-handoff.pdf',
        '3. Sign, then download the signed PDF and send it back to me.',
        'The file opens in your browser. Nothing is uploaded.',
      ].join('\n'),
    );
    // Joiners stay: some names and emoji need them.
    expect(handoffMessage('Mi\u200cna', null, 'x.pdf')).toContain('Hi Mi\u200cna,');
    // The file name and the message use one sanitizer, so they cannot differ.
    const name = handoffFileName(plainLine('two\nparty.pdf'), 1, 2);
    expect(name).toBe('two party-signed-1-of-2-handoff.pdf');
    expect(handoffMessage('B', null, name)).toContain(`: ${name}\n`);
    expect(handoffMessage('B', null, 'x.pdf')).toContain('1. Go to the sign-pdf web app\n');
  });
});
