import { describe, expect, it, vi } from 'vitest';
import { hashWithoutRelay, parseRelayLink, readRelayLink } from './relayLink.ts';
import { hashWithoutSession, readSessionNonce } from './transport.ts';

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

describe('parseRelayLink', () => {
  it('reads the next signer link, with and without a password', () => {
    expect(parseRelayLink(`#relay=${ID}&k=${KEY}`)).toEqual({ id: ID, key: KEY, password: false });
    expect(parseRelayLink(`#relay=${ID}&k=${KEY}&p=1`)).toEqual({ id: ID, key: KEY, password: true });
    expect(parseRelayLink(`#p=1&k=${KEY}&relay=${ID}`)).toEqual({ id: ID, key: KEY, password: true });
  });

  it('reads the return link, which has no key', () => {
    expect(parseRelayLink(`#relay=${ID}`)).toEqual({ id: ID, password: false });
  });

  it.each([
    ['no relay part', `#k=${KEY}`],
    ['an empty id', '#relay='],
    ['a short id', `#relay=${ID.slice(1)}&k=${KEY}`],
    ['a non-canonical id', `#relay=${ID.slice(0, 21)}x`],
    ['a short key', `#relay=${ID}&k=${KEY.slice(1)}`],
    ['a non-canonical key', `#relay=${ID}&k=${KEY.slice(0, 42)}9`],
    ['a percent-encoded key', `#relay=${ID}&k=${KEY.slice(0, 40)}%41`],
    ['a repeated part', `#relay=${ID}&relay=${ID}`],
    ['a repeated key', `#relay=${ID}&k=${KEY}&k=${KEY}`],
    ['p other than 1', `#relay=${ID}&k=${KEY}&p=0`],
    ['p without a key', `#relay=${ID}&p=1`],
  ])('refuses a link with %s', (_name, hash) => {
    expect(parseRelayLink(hash)).toBeNull();
  });

  it('is not a session link, and a session link is not a relay link', () => {
    expect(readSessionNonce(`#relay=${ID}&k=${KEY}&p=1`)).toBeNull();
    expect(readSessionNonce(`#relay=${ID}`)).toBeNull();
    expect(parseRelayLink(`#session=${KEY}`)).toBeNull();
    expect(parseRelayLink(`#session=${ID}`)).toBeNull();
    // Each strip keeps the other's parts.
    expect(hashWithoutSession(`#relay=${ID}&k=${KEY}`)).toBe(`#relay=${ID}&k=${KEY}`);
    expect(hashWithoutRelay(`#session=${KEY}`)).toBe(`#session=${KEY}`);
  });
});

describe('readRelayLink', () => {
  const location = (hash: string) => ({ pathname: '/', search: '?x=1', hash });

  it('returns the link and takes it out of the address bar', () => {
    const replaceState = vi.fn();
    const link = readRelayLink(location(`#relay=${ID}&k=${KEY}&p=1`), { replaceState, state: { s: 1 } });
    expect(link).toEqual({ id: ID, key: KEY, password: true });
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/?x=1');
  });

  it('keeps other fragment parts', () => {
    const replaceState = vi.fn();
    readRelayLink(location(`#view=sign&relay=${ID}&k=${KEY}`), { replaceState, state: null });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?x=1#view=sign');
  });

  it('strips a malformed relay link too, since it can hold a key', () => {
    const replaceState = vi.fn();
    expect(readRelayLink(location(`#relay=bad&k=${KEY}`), { replaceState, state: null })).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?x=1');
    // A key whose relay part was lost or misspelled.
    expect(readRelayLink(location(`#view=sign&rely=${ID}&k=${KEY}`), { replaceState, state: null })).toBeNull();
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/?x=1#view=sign&rely=AAECAwQFBgcICQoLDA0ODw');
  });

  it('leaves the address alone when there is no relay part', () => {
    const replaceState = vi.fn();
    expect(readRelayLink(location(`#session=${KEY}`), { replaceState, state: null })).toBeNull();
    expect(readRelayLink(location(''), { replaceState, state: null })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
