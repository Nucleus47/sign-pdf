import { renderHook } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedDocument } from '../app/open.ts';
import { setCore } from '../lib/core.ts';
import { emptyPrepareState, prepareReducer, type PrepareAction } from '../lib/fields.ts';
import { FIELDS, SHA, fakeCore, makeResolved } from '../testing/fixtures.ts';
import { useAgentApi } from './expose.ts';

const doc: LoadedDocument = {
  name: 'agreement.pdf',
  bytes: new Uint8Array([1, 2, 3]),
  sha256: SHA,
  inspection: { sha256: SHA, pages: [], acroFields: [], text: [], rules: [], imageOnlyPages: [], warnings: [] },
};

const report = { ok: true, sha256: SHA, pages: [{ page: 1, width: 612, height: 792 }], fields: [], errors: [], warnings: [] };

/** The hook as Prepare uses it: state from a reducer, read through the view's props. */
function mount() {
  const seen: PrepareAction[] = [];
  const hook = renderHook(() => {
    const [state, dispatch] = useReducer(prepareReducer, emptyPrepareState);
    return useAgentApi({
      document: () => doc,
      state: () => state,
      dispatch: (action) => {
        seen.push(action);
        dispatch(action);
      },
    });
  });
  return { hook, seen };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  delete window.signPdf;
});

describe('useAgentApi', () => {
  it('reads its own write at once: get_state right after apply_request sees the new fields', async () => {
    restore = setCore(fakeCore({ validateRequest: () => Promise.resolve({ report, resolved: makeResolved() }) }));
    const { hook } = mount();
    const api = hook.result.current;
    expect(await api.apply_request({ request: { fields: [] } })).toMatchObject({ applied: true });
    expect(await api.get_state()).toMatchObject({ field_count: FIELDS.length });
    hook.unmount();
  });

  it('does nothing after the view unmounts, even through a saved reference', async () => {
    const validateRequest = vi.fn(() => Promise.resolve({ report, resolved: makeResolved() }));
    restore = setCore(fakeCore({ validateRequest }));
    const { hook, seen } = mount();
    const saved = window.signPdf;
    expect(saved).toBe(hook.result.current);
    hook.unmount();
    expect(window.signPdf).toBeUndefined();

    for (const name of saved!.tools) {
      expect(await saved![name]({ request: { fields: [] } }), name).toMatchObject({ error: { code: 'closed' } });
    }
    expect(validateRequest).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('drops a write that finishes after the view unmounts', async () => {
    let finish: (value: unknown) => void = () => {};
    restore = setCore(fakeCore({ validateRequest: () => new Promise((resolve) => (finish = resolve)) as never }));
    const { hook, seen } = mount();
    const pending = hook.result.current.apply_request({ request: { fields: [] } });
    hook.unmount();
    finish({ report, resolved: makeResolved() });
    expect(await pending).toMatchObject({ error: { code: 'closed' } });
    expect(seen).toEqual([]);
  });
});
