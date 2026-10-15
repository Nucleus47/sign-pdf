/**
 * What the first signer's device keeps about each emailed document, so it can
 * open the signed PDF that comes back (issue #65):
 *
 *   localStorage["sign-pdf.relay.<id>"] = { k, p, exp, to, n? }
 *
 * `k` is the document key, `p` whether a password was set (the password is
 * never kept), `exp` the relay's expiry time, `to` the next signer's
 * address and `n` the file name for the signed PDF.
 *
 * An entry is written when the email flow made its relay id, before the
 * upload, and again with the relay's expiry once the email went out. The key
 * also opens the encrypted copy kept to send the document again
 * (sentStore.ts, issue #98), so an entry stays RELAY_KEEP_AFTER_EXPIRY_DAYS
 * after its link expired; then it is removed when the app starts.
 */
import { Email, RelayDocId, RelayKey } from '@sign-pdf/spec';

export const RELAY_STORE_PREFIX = 'sign-pdf.relay.';

/** How long the key and the encrypted copy stay on this device after the link expired, to send it again. */
export const RELAY_KEEP_AFTER_EXPIRY_DAYS = 7;
const KEEP_AFTER_EXPIRY_MS = RELAY_KEEP_AFTER_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export interface RelayEntry {
  k: string;
  p: boolean;
  exp: string;
  to: string;
  /** The file name for the signed PDF, such as `agreement-signed.pdf`. */
  n?: string;
}

/** The longest file name kept. */
export const RELAY_NAME_MAX = 200;

/** The entry with exactly these well-formed keys, or null. */
function asEntry(value: unknown): RelayEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { k, p, exp, to, n, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (!RelayKey.safeParse(k).success || typeof p !== 'boolean') return null;
  if (typeof exp !== 'string' || !Number.isFinite(Date.parse(exp))) return null;
  const address = Email.safeParse(to);
  if (!address.success) return null;
  if (n !== undefined && (typeof n !== 'string' || n === '' || n.length > RELAY_NAME_MAX || /[\u0000-\u001f\u007f/\\]/.test(n))) {
    return null;
  }
  const entry: RelayEntry = { k: k as string, p, exp, to: address.data };
  return n === undefined ? entry : { ...entry, n };
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** Keep the entry for document `id`. Returns false when the device cannot store it. */
export function saveRelayEntry(storage: Store | undefined, id: string, entry: RelayEntry): boolean {
  if (!RelayDocId.safeParse(id).success || !asEntry(entry)) return false;
  try {
    if (!storage) return false;
    storage.setItem(`${RELAY_STORE_PREFIX}${id}`, JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

/**
 * The live entry for document `id`, or null when there is none, it is damaged
 * or it expired. With `afterExpiry`, an entry counts as live until
 * RELAY_KEEP_AFTER_EXPIRY_DAYS after its link expired: the key of a kept copy.
 */
export function loadRelayEntry(
  storage: Store | undefined,
  id: string,
  now: number = Date.now(),
  options: { afterExpiry?: boolean } = {},
): RelayEntry | null {
  if (!RelayDocId.safeParse(id).success) return null;
  try {
    const text = storage?.getItem(`${RELAY_STORE_PREFIX}${id}`);
    if (!text) return null;
    const entry = asEntry(JSON.parse(text));
    const until = entry ? Date.parse(entry.exp) + (options.afterExpiry ? KEEP_AFTER_EXPIRY_MS : 0) : 0;
    return entry && until > now ? entry : null;
  } catch {
    return null;
  }
}

/** Remove the entry for document `id`. */
export function removeRelayEntry(storage: Store | undefined, id: string): void {
  if (!RelayDocId.safeParse(id).success) return;
  try {
    storage?.removeItem(`${RELAY_STORE_PREFIX}${id}`);
  } catch {
    // No storage: nothing to remove.
  }
}

/** Remove every relay entry past its keep time, or that cannot be read. Returns how many were removed. */
export function pruneRelayEntries(storage: Store | undefined, now: number = Date.now()): number {
  if (!storage) return 0;
  try {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);
      if (!name?.startsWith(RELAY_STORE_PREFIX)) continue;
      const id = name.slice(RELAY_STORE_PREFIX.length);
      if (!loadRelayEntry(storage, id, now, { afterExpiry: true })) stale.push(name);
    }
    for (const name of stale) storage.removeItem(name);
    return stale.length;
  } catch {
    return 0;
  }
}
