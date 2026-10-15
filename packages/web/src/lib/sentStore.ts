/**
 * The hand-offs this device emailed, kept so the first signer can send one
 * again (issue #98): after a failed send, a reload, an expired link, or a next
 * signer who never opened it.
 *
 *   IndexedDB "sign-pdf" / "sent-handoffs", key = relay id
 *
 * Each entry holds the ciphertext that was uploaded to the relay (encrypted
 * with the link key under that relay id, purpose "handoff"; relayCrypto.ts),
 * never the packet. The key stays in localStorage (relayStore.ts); without it
 * the copy cannot be opened, and it is removed at start-up.
 *
 * An entry is written when the email flow made its relay id, before the upload,
 * so a failed send survives a reload. `sentAt` is set once the relay emailed
 * the next signer. Every function here catches its own errors: without
 * IndexedDB the app works, and only the retry in the open tab exists.
 */
import { RelayDocId } from '@sign-pdf/spec';
import { RELAY_KEEP_AFTER_EXPIRY_DAYS, loadRelayEntry, removeRelayEntry, saveRelayEntry, type RelayEntry } from './relayStore.ts';

export const SENT_DB_NAME = 'sign-pdf';
const SENT_DB_VERSION = 1;
const SENT_STORE = 'sent-handoffs';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SentHandoff {
  /** The relay id of the latest send. */
  id: string;
  /** The encrypted hand-off as uploaded for `id`: only the key in localStorage (and the password, if set) opens it. */
  blob: Uint8Array;
  /** The document's name, for the list (untrusted text). */
  document: string;
  /** The next signer's name, as the request names them (untrusted text). */
  next: string;
  /** The hand-off PDF's file name, for "Download the PDF for <next>". */
  fileName: string;
  /** The file name for the signed PDF that comes back. */
  signedName?: string;
  /** The next signer's address of the latest send. */
  to?: string;
  createdAt: string;
  /** When the relay emailed the next signer; absent while the send did not finish. */
  sentAt?: string;
  /** When the link expires: the relay's expiry once sent, else the flow's start + 7 days. */
  exp: string;
  /** The relay ids of earlier sends of the same hand-off, newest first. Their links still work. */
  prev: string[];
}

export type SentFactory = Pick<IDBFactory, 'open'>;

function defaultFactory(): SentFactory | undefined {
  try {
    return globalThis.indexedDB ?? undefined;
  } catch {
    return undefined;
  }
}

const isText = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is string =>
  typeof value === 'string' && value !== '' && value.length <= max;
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** The entry with the expected shape, or null. */
function asSent(value: unknown): SentHandoff | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!RelayDocId.safeParse(item.id).success) return null;
  // Not instanceof: a blob read back from IndexedDB can come from another realm.
  if (!ArrayBuffer.isView(item.blob) || Object.prototype.toString.call(item.blob) !== '[object Uint8Array]') return null;
  if (!isText(item.document, 1000) || !isText(item.next, 1000) || !isText(item.fileName, 1000)) return null;
  if (item.signedName !== undefined && !isText(item.signedName, 1000)) return null;
  if (item.to !== undefined && !isText(item.to, 254)) return null;
  if (!isTime(item.createdAt) || !isTime(item.exp) || (item.sentAt !== undefined && !isTime(item.sentAt))) return null;
  if (!Array.isArray(item.prev) || !item.prev.every((id) => RelayDocId.safeParse(id).success)) return null;
  return item as unknown as SentHandoff;
}

/** When the copy is removed from this device. */
export function keepUntil(entry: Pick<SentHandoff, 'exp'>): number {
  return Date.parse(entry.exp) + RELAY_KEEP_AFTER_EXPIRY_DAYS * DAY_MS;
}

/** The link's expiry for a send that has not reached the relay: now + the relay's lifetime. */
export function expiryFrom(now: number, ttlDays: number): string {
  return new Date(now + ttlDays * DAY_MS).toISOString();
}

function openDb(factory: SentFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(SENT_DB_NAME, SENT_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SENT_STORE)) {
        request.result.createObjectStore(SENT_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB did not open.'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked.'));
  });
}

/** Run `work` in one transaction; resolves when it commits. */
async function inStore<T>(
  factory: SentFactory | undefined,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => (() => T) | void,
): Promise<T | undefined> {
  if (!factory) throw new Error('No IndexedDB.');
  const db = await openDb(factory);
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(SENT_STORE, mode);
      const read = work(tx.objectStore(SENT_STORE));
      tx.oncomplete = () => resolve(read ? read() : undefined);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
    });
  } finally {
    db.close();
  }
}

async function readAll(factory: SentFactory | undefined): Promise<unknown[]> {
  const all = await inStore<unknown[]>(factory, 'readonly', (store) => {
    const request = store.getAll();
    return () => request.result as unknown[];
  });
  return all ?? [];
}

/** Keep (or replace) the entry for its id. Returns false when the device cannot store it. */
export async function keepSentHandoff(entry: SentHandoff, factory = defaultFactory()): Promise<boolean> {
  if (!asSent(entry)) return false;
  try {
    await inStore(factory, 'readwrite', (store) => {
      store.put(entry);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A new send of `old` went out under a new id: keep the new entry, then remove
 * the old one, in one transaction. The old link still works until it expires;
 * its id moves to `prev`. Returns false when the device cannot store it.
 */
/** A send that went out under a new id: its ciphertext, address and expiry. */
export interface NewSend {
  id: string;
  to: string;
  exp: string;
  blob: Uint8Array;
}

/**
 * Keep a hand-off that just got its relay id, before the upload: its key in
 * localStorage and its ciphertext here. Both are needed to open it later.
 * Returns false when the device cannot keep both.
 */
export async function keepNewHandoff(
  entry: SentHandoff,
  key: Pick<RelayEntry, 'k' | 'p' | 'to' | 'n'>,
  relayStorage: Parameters<typeof saveRelayEntry>[0],
  factory = defaultFactory(),
): Promise<boolean> {
  const relay: RelayEntry = { k: key.k, p: key.p, exp: entry.exp, to: key.to, ...(key.n ? { n: key.n } : {}) };
  if (!saveRelayEntry(relayStorage, entry.id, relay)) return false;
  if (await keepSentHandoff(entry, factory)) return true;
  // No copy to open: the key of a send that has not gone out is not kept alone.
  removeRelayEntry(relayStorage, entry.id);
  return false;
}

/**
 * The entry for a new send of `old` under a new id. The old link still works
 * until it expires; its id moves to `prev`, so collecting either one removes the entry.
 */
export function resentEntry(old: SentHandoff, sent: NewSend, now: number = Date.now()): SentHandoff {
  return {
    ...old,
    id: sent.id,
    blob: sent.blob,
    to: sent.to,
    exp: sent.exp,
    sentAt: new Date(now).toISOString(),
    // An unsent entry's id never reached a next signer: no link to remember.
    prev: old.sentAt ? [old.id, ...old.prev] : [...old.prev],
  };
}

/**
 * A new send of `old` went out: keep the new entry and remove the old one, in
 * one transaction. Returns the new entry, or null when the device cannot store it.
 */
export async function replaceSentHandoff(
  old: SentHandoff,
  sent: NewSend,
  now: number = Date.now(),
  factory = defaultFactory(),
): Promise<SentHandoff | null> {
  const entry = resentEntry(old, sent, now);
  if (!asSent(entry)) return null;
  try {
    await inStore(factory, 'readwrite', (store) => {
      store.put(entry);
      if (old.id !== entry.id) store.delete(old.id);
    });
    return entry;
  } catch {
    return null;
  }
}

/** The kept entries, newest first; damaged ones and ones past their keep time are left out. */
export async function listSentHandoffs(now: number = Date.now(), factory = defaultFactory()): Promise<SentHandoff[]> {
  try {
    const entries = (await readAll(factory)).map(asSent).filter((entry): entry is SentHandoff => entry !== null);
    return entries
      .filter((entry) => keepUntil(entry) > now)
      .sort((a, b) => Date.parse(b.sentAt ?? b.createdAt) - Date.parse(a.sentAt ?? a.createdAt));
  } catch {
    return [];
  }
}

/** Remove the entry for `id`. */
export async function removeSentHandoff(id: string, factory = defaultFactory()): Promise<boolean> {
  try {
    await inStore(factory, 'readwrite', (store) => {
      store.delete(id);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The signed PDF for `id` came back: remove the entry of that send, and the
 * entry of a later send of the same hand-off (`id` is in its `prev`).
 */
export async function forgetCollected(id: string, factory = defaultFactory()): Promise<void> {
  try {
    const stale = (await readAll(factory))
      .map(asSent)
      .filter((entry): entry is SentHandoff => entry !== null && (entry.id === id || entry.prev.includes(id)))
      .map((entry) => entry.id);
    if (stale.length === 0) return;
    await inStore(factory, 'readwrite', (store) => {
      for (const staleId of stale) store.delete(staleId);
    });
  } catch {
    // Nothing kept, or no IndexedDB: the keep time removes it.
  }
}

/**
 * Remove, at start-up: damaged entries, entries past their keep time, and
 * entries whose key is gone from localStorage (the signed PDF was collected,
 * the site data was cleared, or there is no localStorage): without the key
 * the copy cannot be opened. Returns how many.
 */
export async function pruneSentHandoffs(
  relayStorage: Parameters<typeof loadRelayEntry>[0],
  now: number = Date.now(),
  factory = defaultFactory(),
): Promise<number> {
  try {
    const stale: IDBValidKey[] = [];
    for (const raw of await readAll(factory)) {
      const entry = asSent(raw);
      if (!entry) {
        const key = (raw as { id?: unknown } | null)?.id;
        if (typeof key === 'string') stale.push(key);
        continue;
      }
      const keyGone = !loadRelayEntry(relayStorage, entry.id, now, { afterExpiry: true });
      if (keepUntil(entry) <= now || keyGone) stale.push(entry.id);
    }
    if (stale.length === 0) return 0;
    await inStore(factory, 'readwrite', (store) => {
      for (const id of stale) store.delete(id);
    });
    return stale.length;
  } catch {
    return 0;
  }
}
