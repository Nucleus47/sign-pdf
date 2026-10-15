import { describe, expect, it } from 'vitest';
import { loadRelayEntry, pruneRelayEntries, removeRelayEntry, saveRelayEntry, type RelayEntry } from './relayStore.ts';

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const OTHER = 'EBESExQVFhcYGRobHB0eHw';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const NOW = Date.parse('2026-10-07T12:00:00Z');
const ENTRY: RelayEntry = { k: KEY, p: false, exp: '2026-10-14T12:00:00.000Z', to: 'b@example.com' };

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
  };
}

describe('relay store', () => {
  it('keeps the signed file name, refuses a bad one, and removes an entry', () => {
    const storage = memoryStorage();
    const named = { ...ENTRY, n: 'agreement-signed.pdf' };
    expect(saveRelayEntry(storage, ID, named)).toBe(true);
    expect(loadRelayEntry(storage, ID, NOW)).toEqual(named);
    expect(saveRelayEntry(storage, OTHER, { ...ENTRY, n: '' })).toBe(false);
    expect(saveRelayEntry(storage, OTHER, { ...ENTRY, n: 'x'.repeat(201) })).toBe(false);
    expect(saveRelayEntry(storage, OTHER, { ...ENTRY, n: '../a.pdf' })).toBe(false);
    removeRelayEntry(storage, ID);
    expect(loadRelayEntry(storage, ID, NOW)).toBeNull();
  });

  it('saves and loads an entry under sign-pdf.relay.<id>', () => {
    const storage = memoryStorage();
    expect(saveRelayEntry(storage, ID, ENTRY)).toBe(true);
    expect(JSON.parse(storage.items.get(`sign-pdf.relay.${ID}`)!)).toEqual(ENTRY);
    expect(loadRelayEntry(storage, ID, NOW)).toEqual(ENTRY);
    expect(loadRelayEntry(storage, OTHER, NOW)).toBeNull();
  });

  it('refuses a malformed id or entry, and a device without storage', () => {
    const storage = memoryStorage();
    expect(saveRelayEntry(storage, 'not-an-id', ENTRY)).toBe(false);
    expect(saveRelayEntry(storage, ID, { ...ENTRY, k: 'short' })).toBe(false);
    expect(saveRelayEntry(storage, ID, { ...ENTRY, to: 'nobody' })).toBe(false);
    expect(saveRelayEntry(storage, ID, { ...ENTRY, exp: 'soon' })).toBe(false);
    expect(storage.items.size).toBe(0);
    expect(saveRelayEntry(undefined, ID, ENTRY)).toBe(false);
    const full = { ...memoryStorage(), setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(saveRelayEntry(full, ID, ENTRY)).toBe(false);
  });

  it('does not load an expired or damaged entry, or one with extra keys', () => {
    const storage = memoryStorage();
    storage.setItem(`sign-pdf.relay.${ID}`, JSON.stringify(ENTRY));
    expect(loadRelayEntry(storage, ID, Date.parse(ENTRY.exp))).toBeNull();
    storage.setItem(`sign-pdf.relay.${ID}`, '{not json');
    expect(loadRelayEntry(storage, ID, NOW)).toBeNull();
    storage.setItem(`sign-pdf.relay.${ID}`, JSON.stringify({ ...ENTRY, password: 'secret' }));
    expect(loadRelayEntry(storage, ID, NOW)).toBeNull();
  });

  it('keeps an expired link\'s key for 7 days, to open the kept copy', () => {
    const storage = memoryStorage();
    storage.setItem(`sign-pdf.relay.${ID}`, JSON.stringify({ ...ENTRY, exp: '2026-10-01T00:00:00.000Z' }));
    expect(loadRelayEntry(storage, ID, NOW)).toBeNull();
    expect(loadRelayEntry(storage, ID, NOW, { afterExpiry: true })?.k).toBe(KEY);
    expect(loadRelayEntry(storage, ID, Date.parse('2026-10-08T00:00:00.000Z'), { afterExpiry: true })).toBeNull();
  });

  it('prunes entries past their keep time and damaged entries on start, and leaves everything else', () => {
    const storage = memoryStorage();
    const third = 'ICEiIyQlJicoKSorLC0uLw';
    storage.setItem(`sign-pdf.relay.${ID}`, JSON.stringify(ENTRY));
    // Link expired 6 days ago: still kept. 8 days ago: removed.
    storage.setItem(`sign-pdf.relay.${third}`, JSON.stringify({ ...ENTRY, exp: '2026-10-01T12:00:01.000Z' }));
    storage.setItem(`sign-pdf.relay.${OTHER}`, JSON.stringify({ ...ENTRY, exp: '2026-09-29T00:00:00.000Z' }));
    storage.setItem('sign-pdf.relay.junk', 'x');
    storage.setItem('sign-pdf.other-setting', '1');
    expect(pruneRelayEntries(storage, NOW)).toBe(2);
    expect([...storage.items.keys()].sort()).toEqual(
      ['sign-pdf.other-setting', `sign-pdf.relay.${ID}`, `sign-pdf.relay.${third}`].sort(),
    );
    expect(pruneRelayEntries(undefined, NOW)).toBe(0);
  });
});
