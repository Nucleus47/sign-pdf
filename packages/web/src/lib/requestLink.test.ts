import { describe, expect, it, vi } from 'vitest';
import { MAX_REQUEST_LINK_CHARS, parseRequestLink, readRequestLink } from './requestLink.ts';

const request = { fields: [{ id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'anchor', text: 'Signature:' } }] };
const base64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('parseRequestLink', () => {
  it('reads percent-encoded JSON and base64url JSON', () => {
    expect(parseRequestLink(`#request=${encodeURIComponent(JSON.stringify(request))}`)).toEqual({ ok: true, request });
    expect(parseRequestLink(`#request=${base64url(JSON.stringify(request))}`)).toEqual({ ok: true, request });
  });

  it('ignores other fragments', () => {
    expect(parseRequestLink('')).toBeNull();
    expect(parseRequestLink('#relay=abc')).toBeNull();
  });

  it('refuses a value over the cap, bad JSON and non-objects', () => {
    expect(parseRequestLink(`#request=${'a'.repeat(MAX_REQUEST_LINK_CHARS + 1)}`)).toMatchObject({ ok: false });
    expect(parseRequestLink('#request=%7Bnot json')).toMatchObject({ ok: false });
    expect(parseRequestLink(`#request=${encodeURIComponent('[1]')}`)).toMatchObject({ ok: false, error: expect.stringContaining('not a JSON object') });
  });
});

describe('readRequestLink', () => {
  it('takes the request out of the address bar', () => {
    const history = { state: null, replaceState: vi.fn() };
    const link = readRequestLink({ pathname: '/', search: '?a=1', hash: `#request=${encodeURIComponent('{}')}` }, history);
    expect(link).toEqual({ ok: true, request: {} });
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/?a=1');
  });

  it('leaves an address without a request alone', () => {
    const history = { state: null, replaceState: vi.fn() };
    expect(readRequestLink({ pathname: '/', search: '', hash: '#x' }, history)).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
