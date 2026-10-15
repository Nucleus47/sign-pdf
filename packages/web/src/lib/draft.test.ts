import type { ResolvedField } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import { FIELDS, makeResolved, SHA, TWO_SIGNER_FIELDS } from '../testing/fixtures.ts';
import { draftFromRequest } from './draft.ts';
import { buildRequest, draftIssues, emptyPrepareState, prepareReducer } from './fields.ts';

const document = { name: 'agreement.pdf', sha256: SHA };

describe('draftFromRequest', () => {
  it('round-trips a request through the draft', () => {
    const resolved = makeResolved(FIELDS, { title: 'NDA', note: 'Please sign', signer: { name: 'Test Signer' } });
    const action = draftFromRequest(resolved);
    const state = prepareReducer(emptyPrepareState, action);
    expect(buildRequest(state, document)).toEqual(resolved.request);
    expect(draftIssues(state.fields, state.signers)).toEqual([]);
  });

  it('keeps anchor and form-field placements and the signers', () => {
    const anchored: ResolvedField = {
      ...(FIELDS[5] as ResolvedField),
      placement: { kind: 'anchor', text: 'Signature:', occurrence: 1, align: 'right', width: 180, height: 44, dx: 0, dy: 0 },
    };
    const linked: ResolvedField = { ...(FIELDS[1] as ResolvedField), placement: { kind: 'acroField', name: 'Title' } };
    const signers = [{ id: 'a', name: 'Signer One' }, { id: 'b' }];
    const action = draftFromRequest(makeResolved([anchored, linked], {}));
    expect(action.fields[0]?.anchor).toMatchObject({ kind: 'anchor', text: 'Signature:' });
    expect(action.fields[1]?.acroField).toBe('Title');
    const two = draftFromRequest(makeResolved(TWO_SIGNER_FIELDS, { signers }));
    expect(two.signers).toEqual(signers);
    const state = prepareReducer(emptyPrepareState, two);
    expect(buildRequest(state, document)).toEqual(makeResolved(TWO_SIGNER_FIELDS, { signers }).request);
  });

  it('is one undo step', () => {
    const before = prepareReducer(emptyPrepareState, draftFromRequest(makeResolved(FIELDS.slice(0, 1))));
    const after = prepareReducer(before, draftFromRequest(makeResolved(FIELDS)));
    expect(prepareReducer(after, { type: 'undo' }).fields).toEqual(before.fields);
  });

  it('flags a human field without a signer when the draft has signers', () => {
    const state = prepareReducer(emptyPrepareState, draftFromRequest(makeResolved(TWO_SIGNER_FIELDS, { signers: [{ id: 'a' }, { id: 'b' }] })));
    const added = prepareReducer(state, { type: 'add', field: { id: 'text9', type: 'text', label: 'Extra', assignee: 'human', required: true, rect: { page: 1, x: 1, y: 1, width: 10, height: 10 } } });
    expect(draftIssues(added.fields, added.signers)).toEqual([{ fieldId: 'text9', message: expect.stringContaining('has no signer') }]);
  });
});
