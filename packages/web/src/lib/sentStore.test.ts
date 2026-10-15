// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { RELAY_KEEP_AFTER_EXPIRY_DAYS, loadRelayEntry, saveRelayEntry } from './relayStore.ts';
import {
  forgetCollected,
  keepNewHandoff,
  keepSentHandoff,
  listSentHandoffs,
  pruneSentHandoffs,
  removeSentHandoff,
  replaceSentHandoff,
  type SentFactory,
  type SentHandoff,
} from './sentStore.ts';

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const OTHER = 'EBESExQVFhcYGRobHB0eHw';
const THIRD = 'ICEiIyQlJicoKSorLC0uLw';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ENTRY: SentHandoff = {
  id: ID,
  // Synthetic ciphertext bytes: the store never sees a packet.
  blob: new Uint8Array([1, 2, 3, 250]),
  document: 'agreement.pdf',
  next: 'Bea Example',
  fileName: 'agreement-signed-1-of-2-handoff.pdf',
  signedName: 'agreement-signed.pdf',
  to: 'b@example.com',
  createdAt: '2026-10-08T11:00:00.000Z',
  sentAt: '2026-10-08T11:01:00.000Z',
  exp: '2026-10-15T11:01:00.000Z',
  prev: [],
};

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

const keyFor = (storage: ReturnType<typeof memoryStorage>, id: string, exp = ENTRY.exp) =>
  saveRelayEntry(storage, id, { k: KEY, p: false, exp, to: 'b@example.com' });

describe('sent store', () => {
  it('keeps, lists (newest first) and removes entries', async () => {
    const db = new IDBFactory();
    const later = { ...ENTRY, id: OTHER, sentAt: '2026-10-08T11:30:00.000Z' };
    expect(await keepSentHandoff(ENTRY, db)).toBe(true);
    expect(await keepSentHandoff(later, db)).toBe(true);
    expect((await listSentHandoffs(NOW, db)).map((entry) => entry.id)).toEqual([OTHER, ID]);
    expect(await removeSentHandoff(OTHER, db)).toBe(true);
    expect(await listSentHandoffs(NOW, db)).toEqual([ENTRY]);
  });

  it('refuses a malformed entry, and works without IndexedDB', async () => {
    const db = new IDBFactory();
    expect(await keepSentHandoff({ ...ENTRY, id: 'not-an-id' }, db)).toBe(false);
    expect(await keepSentHandoff({ ...ENTRY, exp: 'soon' }, db)).toBe(false);
    expect(await listSentHandoffs(NOW, db)).toEqual([]);
    const broken: SentFactory = {
      open: () => {
        throw new Error('SecurityError');
      },
    };
    expect(await keepSentHandoff(ENTRY, broken)).toBe(false);
    expect(await keepSentHandoff(ENTRY, undefined)).toBe(false);
    expect(await listSentHandoffs(NOW, broken)).toEqual([]);
    expect(await removeSentHandoff(ID, broken)).toBe(false);
    expect(await pruneSentHandoffs(memoryStorage(), NOW, broken)).toBe(0);
  });

  it('replaces an entry with a new send and remembers the old id', async () => {
    const db = new IDBFactory();
    await keepSentHandoff(ENTRY, db);
    const blob = new Uint8Array([9, 8, 7]);
    const sent = await replaceSentHandoff(ENTRY, { id: OTHER, to: 'c@example.com', exp: '2026-10-20T00:00:00.000Z', blob }, NOW, db);
    expect(sent).toMatchObject({ id: OTHER, to: 'c@example.com', prev: [ID], blob });
    expect(await listSentHandoffs(NOW, db)).toEqual([sent]);
    // An unsent entry's id is not remembered: no link went out with it.
    const unsent = { ...ENTRY, id: THIRD, prev: [ID] } as SentHandoff;
    delete unsent.sentAt;
    expect((await replaceSentHandoff(unsent, { id: OTHER, to: 'c@example.com', exp: ENTRY.exp, blob }, NOW, db))?.prev).toEqual([ID]);
  });

  it('forgets the entry when the signed PDF of any of its sends came back', async () => {
    const db = new IDBFactory();
    await keepSentHandoff({ ...ENTRY, id: OTHER, prev: [ID] }, db);
    await keepSentHandoff({ ...ENTRY, id: THIRD }, db);
    await forgetCollected(ID, db);
    expect((await listSentHandoffs(NOW, db)).map((entry) => entry.id)).toEqual([THIRD]);
    await forgetCollected(THIRD, db);
    expect(await listSentHandoffs(NOW, db)).toEqual([]);
  });

  it('holds the ciphertext and no packet; keepNewHandoff keeps the key in localStorage first', async () => {
    const db = new IDBFactory();
    const storage = memoryStorage();
    expect(await keepNewHandoff(ENTRY, { k: KEY, p: true, to: 'b@example.com', n: 'agreement-signed.pdf' }, storage, db)).toBe(true);
    const [kept] = await listSentHandoffs(NOW, db);
    expect(Array.from(kept!.blob)).toEqual(Array.from(ENTRY.blob));
    expect(Object.keys(kept!).sort()).not.toContain('packet');
    expect(loadRelayEntry(storage, ID, NOW)).toEqual({ k: KEY, p: true, exp: ENTRY.exp, to: 'b@example.com', n: 'agreement-signed.pdf' });
    // No key, no copy: a copy nothing can open is not kept.
    const full = { ...memoryStorage(), setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(await keepNewHandoff({ ...ENTRY, id: OTHER }, { k: KEY, p: false, to: 'b@example.com' }, full, db)).toBe(false);
    expect((await listSentHandoffs(NOW, db)).map((entry) => entry.id)).toEqual([ID]);
    // No IndexedDB: the key is not left behind either.
    expect(await keepNewHandoff({ ...ENTRY, id: OTHER }, { k: KEY, p: false, to: 'b@example.com' }, storage, undefined)).toBe(false);
    expect(loadRelayEntry(storage, OTHER, NOW)).toBeNull();
  });

  it('prunes entries whose key is gone (sent or not), and entries past the keep time', async () => {
    const db = new IDBFactory();
    const storage = memoryStorage();
    const unsent = { ...ENTRY, id: OTHER } as SentHandoff;
    delete unsent.sentAt;
    // Expired link, still in its keep time, key kept with it: kept, so it can be sent again.
    const expired = { ...ENTRY, id: THIRD, exp: new Date(NOW - DAY).toISOString() };
    keyFor(storage, ID);
    keyFor(storage, THIRD, expired.exp);
    await keepSentHandoff(ENTRY, db);
    await keepSentHandoff(unsent, db); // no key: unusable
    await keepSentHandoff(expired, db);
    expect(await pruneSentHandoffs(storage, NOW, db)).toBe(1);
    expect((await listSentHandoffs(NOW, db)).map((entry) => entry.id).sort()).toEqual([ID, THIRD].sort());

    // The key went (the signed PDF was collected): the copy goes.
    storage.removeItem(`sign-pdf.relay.${ID}`);
    expect(await pruneSentHandoffs(storage, NOW, db)).toBe(1);

    const afterKeep = Date.parse(expired.exp) + RELAY_KEEP_AFTER_EXPIRY_DAYS * DAY;
    expect(await pruneSentHandoffs(storage, afterKeep, db)).toBe(1);
    expect(await listSentHandoffs(afterKeep, db)).toEqual([]);
  });

  it('prunes every entry when there is no localStorage: no copy can be opened', async () => {
    const db = new IDBFactory();
    await keepSentHandoff(ENTRY, db);
    expect(await pruneSentHandoffs(undefined, NOW, db)).toBe(1);
  });
});
