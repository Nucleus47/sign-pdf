import { describe, expect, it } from 'vitest';
import { safeParseSignRequest, type Rect } from '@sign-pdf/spec';
import {
  buildRequest,
  draftIssues,
  emptyPrepareState,
  fieldsFromAcroFields,
  makeField,
  nextFieldId,
  prepareReducer,
  type PrepareAction,
  type PrepareState,
} from './fields.ts';

const rect: Rect = { page: 1, x: 72, y: 100, width: 180, height: 18 };
const sha256 = 'a'.repeat(64);

function run(actions: PrepareAction[], start: PrepareState = emptyPrepareState): PrepareState {
  return actions.reduce(prepareReducer, start);
}

function withFields(): PrepareState {
  const text = makeField({ type: 'text', rect, label: 'Company' }, []);
  const signature = makeField({ type: 'signature', rect: { ...rect, y: 200, height: 44 } }, [text.id]);
  return run([
    { type: 'add', field: text },
    { type: 'add', field: signature },
  ]);
}

describe('field ids', () => {
  it('numbers ids per type and skips taken ones', () => {
    expect(nextFieldId('text', [])).toBe('text1');
    expect(nextFieldId('text', ['text1', 'text2', 'signature1'])).toBe('text3');
    expect(nextFieldId('signature', ['signature1'])).toBe('signature2');
  });
});

describe('prepare reducer', () => {
  it('adds a field and selects it', () => {
    const state = withFields();
    expect(state.fields.map((field) => field.id)).toEqual(['text1', 'signature1']);
    expect(state.selectedId).toBe('signature1');
  });

  it('updates label, assignee and value', () => {
    const state = run(
      [{ type: 'update', id: 'text1', patch: { assignee: 'agent', value: 'Example Company Ltd' } }],
      withFields(),
    );
    expect(state.fields[0]).toMatchObject({ assignee: 'agent', value: 'Example Company Ltd' });
  });

  it('never lets a signature or initials field hold a value or belong to the agent', () => {
    const state = run(
      [{ type: 'update', id: 'signature1', patch: { assignee: 'agent', value: 'forged' } }],
      withFields(),
    );
    const signature = state.fields[1];
    expect(signature?.assignee).toBe('human');
    expect(signature && 'value' in signature).toBe(false);
  });

  it('drops the value when a text field becomes a signature field', () => {
    const state = run(
      [
        { type: 'update', id: 'text1', patch: { assignee: 'agent', value: 'Example' } },
        { type: 'update', id: 'text1', patch: { type: 'signature' } },
      ],
      withFields(),
    );
    expect(state.fields[0]).toMatchObject({ type: 'signature', assignee: 'human' });
    expect(state.fields[0] && 'value' in state.fields[0]).toBe(false);
  });

  it('gives an agent checkbox an explicit false and clears string values', () => {
    const state = run(
      [
        { type: 'update', id: 'text1', patch: { assignee: 'agent', value: 'Example' } },
        { type: 'update', id: 'text1', patch: { type: 'checkbox' } },
      ],
      withFields(),
    );
    expect(state.fields[0]).toMatchObject({ type: 'checkbox', value: false });
  });

  it('moves a field, clamped to its page when the page is given', () => {
    const state = run(
      [{ type: 'setRect', id: 'text1', rect: { ...rect, x: 9999 }, page: { width: 612, height: 792 } }],
      withFields(),
    );
    expect(state.fields[0]?.rect.x).toBe(612 - 180);
  });

  it('removes a field and brings it back with undo', () => {
    const removed = run([{ type: 'remove', id: 'text1' }], withFields());
    expect(removed.fields.map((field) => field.id)).toEqual(['signature1']);
    expect(removed.lastChange).toBe('Removed Company.');
    const restored = run([{ type: 'undo' }], removed);
    expect(restored.fields.map((field) => field.id)).toEqual(['text1', 'signature1']);
  });

  it('clears the selection when the selected field is removed', () => {
    const state = run([{ type: 'remove', id: 'signature1' }], withFields());
    expect(state.selectedId).toBeNull();
  });

  it('undo with nothing to undo changes nothing', () => {
    expect(run([{ type: 'undo' }])).toBe(emptyPrepareState);
  });

  it('does not copy a placeholder form field name such as "undefined" into the label', () => {
    const [field] = fieldsFromAcroFields([{ name: 'undefined', type: 'text', rect, readOnly: false }], []);
    expect(field?.label).toBe('');
    expect(field?.acroField).toBe('undefined');
  });

  it('does not move a field that follows an existing form field until it is unlinked', () => {
    const linked = fieldsFromAcroFields(
      [{ name: 'form.name', type: 'text', rect, readOnly: false }],
      [],
    );
    const start = run([{ type: 'addMany', fields: linked }]);
    const moved = run([{ type: 'setRect', id: 'text1', rect: { ...rect, x: 300 } }], start);
    expect(moved.fields[0]?.rect.x).toBe(72);
    const free = run(
      [
        { type: 'unlink', id: 'text1' },
        { type: 'setRect', id: 'text1', rect: { ...rect, x: 300 } },
      ],
      start,
    );
    expect(free.fields[0]?.rect.x).toBe(300);
    expect(free.fields[0]?.acroField).toBeUndefined();
  });
});

describe('undo for moves', () => {
  const at = 10_000;
  const nudge = (x: number, time: number): PrepareAction => ({
    type: 'setRect',
    id: 'text1',
    rect: { ...rect, x },
    at: time,
  });

  it('makes a move undoable and names it', () => {
    const start = withFields();
    const moved = run([nudge(80, at)], start);
    expect(moved.undo).toHaveLength(start.undo.length + 1);
    expect(moved.lastChange).toBe('Moved Company.');
    const undone = run([{ type: 'undo' }], moved);
    expect(undone.fields[0]?.rect.x).toBe(72);
  });

  it('coalesces a burst of nudges of one field into one undo step', () => {
    const start = withFields();
    const moved = run([nudge(73, at), nudge(74, at + 200), nudge(75, at + 400)], start);
    expect(moved.fields[0]?.rect.x).toBe(75);
    expect(moved.undo).toHaveLength(start.undo.length + 1);
    const undone = run([{ type: 'undo' }], moved);
    expect(undone.fields[0]?.rect.x).toBe(72);
    expect(undone.fields.map((field) => field.id)).toEqual(['text1', 'signature1']);
  });

  it('starts a new step after a pause, for another field, or after another change', () => {
    const start = withFields();
    const paused = run([nudge(73, at), nudge(74, at + 5_000)], start);
    expect(paused.undo).toHaveLength(start.undo.length + 2);

    const other = run(
      [nudge(73, at), { type: 'setRect', id: 'signature1', rect: { ...rect, y: 300, height: 44 }, at: at + 100 }],
      start,
    );
    expect(other.undo).toHaveLength(start.undo.length + 2);

    const interrupted = run(
      [nudge(73, at), { type: 'update', id: 'text1', patch: { label: 'Firm' } }, nudge(74, at + 100)],
      start,
    );
    expect(interrupted.undo).toHaveLength(start.undo.length + 2);
    expect(run([{ type: 'undo' }], interrupted).fields[0]?.label).toBe('Firm');

    const afterUndo = run([nudge(73, at), { type: 'undo' }, nudge(74, at + 100)], start);
    expect(afterUndo.undo).toHaveLength(start.undo.length + 1);
  });

  it('keeps an untimed change as its own step and ignores a move that changes nothing', () => {
    const start = withFields();
    const untimed = run(
      [
        { type: 'setRect', id: 'text1', rect: { ...rect, x: 73 } },
        { type: 'setRect', id: 'text1', rect: { ...rect, x: 74 } },
      ],
      start,
    );
    expect(untimed.undo).toHaveLength(start.undo.length + 2);
    expect(run([{ type: 'setRect', id: 'text1', rect, at }], start)).toBe(start);
  });
});

describe('existing form fields', () => {
  it('creates placements for supported, visible, writable fields only, once', () => {
    const acro = [
      { name: 'name', type: 'text' as const, rect, readOnly: false },
      { name: 'agree', type: 'checkbox' as const, rect, readOnly: false },
      { name: 'sig', type: 'signature' as const, rect, readOnly: false },
      { name: 'country', type: 'dropdown' as const, rect, readOnly: false },
      { name: 'locked', type: 'text' as const, rect, readOnly: true },
      { name: 'hidden', type: 'text' as const, readOnly: false },
    ];
    const created = fieldsFromAcroFields(acro, []);
    expect(created.map((field) => [field.type, field.acroField])).toEqual([
      ['text', 'name'],
      ['checkbox', 'agree'],
      ['signature', 'sig'],
    ]);
    expect(fieldsFromAcroFields(acro, created)).toEqual([]);
  });
});

describe('request export', () => {
  it('builds a request the spec accepts', () => {
    const state = run(
      [
        { type: 'update', id: 'text1', patch: { assignee: 'agent', value: 'Example Company Ltd' } },
        { type: 'details', patch: { title: ' NDA ', note: 'Please sign.', signerName: 'Test Signer' } },
      ],
      withFields(),
    );
    const request = buildRequest(state, { name: 'nda.pdf', sha256 });
    const parsed = safeParseSignRequest(request);
    expect(parsed.success).toBe(true);
    expect(request).toMatchObject({
      version: 1,
      title: 'NDA',
      signer: { name: 'Test Signer' },
      fields: [
        { id: 'text1', type: 'text', assignee: 'agent', value: 'Example Company Ltd', placement: { kind: 'rect', ...rect } },
        { id: 'signature1', type: 'signature', assignee: 'human' },
      ],
    });
    expect(request.fields[1] && 'value' in request.fields[1]).toBe(false);
  });

  it('keeps an existing form field as an acroField placement', () => {
    const linked = fieldsFromAcroFields([{ name: 'form.name', type: 'text', rect, readOnly: false }], []);
    const request = buildRequest({ fields: linked, details: emptyPrepareState.details }, { name: 'a.pdf', sha256 });
    expect(request.fields[0]?.placement).toEqual({ kind: 'acroField', name: 'form.name' });
    expect(safeParseSignRequest(request).success).toBe(true);
  });

  it('keeps an anchor placement until the field moves, then exports its rectangle; undo brings the anchor back', () => {
    const anchor = {
      kind: 'anchor' as const,
      text: 'Signature:',
      page: 1,
      align: 'right' as const,
      dx: 3,
      width: 180,
      height: 20,
    };
    const field = makeField({ type: 'signature', rect: { ...rect, height: 20 }, anchor }, []);
    const added = run([{ type: 'add', field }]);
    const exported = (state: PrepareState) =>
      buildRequest(state, { name: 'a.pdf', sha256 }).fields[0]?.placement;
    expect(exported(added)).toEqual(anchor);
    expect(safeParseSignRequest(buildRequest(added, { name: 'a.pdf', sha256 })).success).toBe(true);

    // Other edits keep it.
    const relabelled = run([{ type: 'update', id: field.id, patch: { label: 'Sign' } }], added);
    expect(exported(relabelled)).toEqual(anchor);

    const moved = run([{ type: 'setRect', id: field.id, rect: { ...rect, x: 80, height: 20 }, at: 1 }], relabelled);
    expect(moved.fields[0]?.anchor).toBeUndefined();
    expect(exported(moved)).toEqual({ kind: 'rect', ...rect, x: 80, height: 20 });

    expect(exported(run([{ type: 'undo' }], moved))).toEqual(anchor);
  });

  it('prefers an existing form field over an anchor when given both', () => {
    const anchor = { kind: 'anchor' as const, text: 'Name:', width: 100, height: 14 };
    const field = makeField({ type: 'text', rect, acroField: 'name', anchor }, []);
    expect(field.anchor).toBeUndefined();
    expect(field.acroField).toBe('name');
  });

  it('reports why a draft cannot be exported', () => {
    expect(draftIssues([])).toEqual([{ message: 'Add at least one field.' }]);
    const state = run([{ type: 'update', id: 'text1', patch: { assignee: 'agent' } }], withFields());
    expect(draftIssues(state.fields)).toEqual([
      { fieldId: 'text1', message: 'Company is filled by the preparer, so it needs a value.' },
    ]);
    expect(draftIssues(withFields().fields)).toEqual([]);
  });
});

describe('setAssignee', () => {
  it('normalises the value and one undo restores the old assignee and value', () => {
    const box = makeField({ type: 'checkbox', rect, label: 'Agree' }, []);
    const start = run([{ type: 'add', field: box }]);
    expect(start.fields[0]?.assignee).toBe('human');
    expect(start.fields[0]).not.toHaveProperty('value');

    const toAgent = run([{ type: 'setAssignee', id: box.id, assignee: 'agent' }], start);
    expect(toAgent.fields[0]).toMatchObject({ assignee: 'agent', value: false });
    expect(toAgent.undo).toHaveLength(start.undo.length + 1);
    expect(toAgent.lastChange).toBe('Agree is now filled by the preparer.');

    const undone = run([{ type: 'undo' }], toAgent);
    expect(undone.fields[0]?.assignee).toBe('human');
    expect(undone.fields[0]).not.toHaveProperty('value');
  });

  it('ignores an unknown field or an unchanged assignee', () => {
    const start = withFields();
    expect(run([{ type: 'setAssignee', id: 'nope', assignee: 'agent' }], start)).toBe(start);
    expect(run([{ type: 'setAssignee', id: 'text1', assignee: 'human' }], start)).toBe(start);
  });
});
