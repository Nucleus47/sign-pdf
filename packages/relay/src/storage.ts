/**
 * Every R2 object the relay keeps, and the expiry check on each read.
 *
 * - `relay/<id>/handoff.bin`: the encrypted hand-off packet. Metadata `from`,
 *   `to`, `password` ("0" or "1"), `expiresAt` (ms since the epoch).
 * - `relay/<id>/sent`: marker, created once when the next signer is emailed.
 *   `{state, at, wrappedKey?}`; the wrapped key (issue #105) moves to the
 *   final gate when the final is uploaded.
 *   R2 cannot change an object's metadata in place, so a create-only marker
 *   replaces a `sent` metadata flag (rewriting 40 MiB to flip one flag).
 * - `relay/<id>/final.bin`: the encrypted signed PDF, create-only. Metadata
 *   `expiresAt`.
 * - `relay/<id>/final.json`: `{to, codeHash, attempts, expiresAt, wrappedKey?}`, the code
 *   gate in front of final.bin, small so each attempt can rewrite it.
 * - `relay/login/<sha256(email)>.json`: `{codeHash, attempts, expiresAt}`.
 * - `relay/dev-outbox/<time>-<random>.json`: mail in dev-outbox mode only.
 *
 * A read of an expired object returns null and deletes it in the background.
 * Callers build keys only from validated ids (RelayDocId) and hex hashes.
 */
import { RelayWrappedKey } from '@sign-pdf/spec';
import { now } from './clock.ts';

export const keys = {
  handoff: (id: string) => `relay/${id}/handoff.bin`,
  sent: (id: string) => `relay/${id}/sent`,
  final: (id: string) => `relay/${id}/final.bin`,
  finalGate: (id: string) => `relay/${id}/final.json`,
  login: (emailHash: string) => `relay/login/${emailHash}.json`,
  outboxPrefix: 'relay/dev-outbox/',
};

/** Create-only: R2 writes only when no object has the key (verified in the emulator, see tests). */
export const CREATE_ONLY: R2Conditional = { etagDoesNotMatch: '*' };

type Background = (promise: Promise<unknown>) => void;

export interface HandoffMeta {
  from: string;
  to: string;
  password: boolean;
  expiresAt: number;
}

export function handoffMetadata(meta: HandoffMeta): Record<string, string> {
  return {
    from: meta.from,
    to: meta.to,
    password: meta.password ? '1' : '0',
    expiresAt: String(meta.expiresAt),
  };
}

function parseHandoffMeta(object: R2Object): HandoffMeta | null {
  const m = object.customMetadata ?? {};
  const expiresAt = Number(m.expiresAt);
  if (!m.from || !m.to || !Number.isFinite(expiresAt)) return null;
  return { from: m.from, to: m.to, password: m.password === '1', expiresAt };
}

/** Deletes every object of one document. Missing keys are fine. */
export function deleteDoc(bucket: R2Bucket, id: string): Promise<void> {
  return bucket.delete([keys.handoff(id), keys.sent(id), keys.final(id), keys.finalGate(id)]);
}

/** The hand-off's metadata, or null when it is missing or expired. */
export async function headHandoff(bucket: R2Bucket, id: string, background: Background): Promise<HandoffMeta | null> {
  const object = await bucket.head(keys.handoff(id));
  return liveHandoff(bucket, id, object, background);
}

export async function getHandoff(
  bucket: R2Bucket,
  id: string,
  background: Background,
): Promise<{ meta: HandoffMeta; body: ReadableStream; size: number } | null> {
  const object = await bucket.get(keys.handoff(id));
  const meta = liveHandoff(bucket, id, object, background);
  if (!object || !meta) return null;
  return { meta, body: object.body, size: object.size };
}

function liveHandoff(
  bucket: R2Bucket,
  id: string,
  object: R2Object | null,
  background: Background,
): HandoffMeta | null {
  if (!object) return null;
  const meta = parseHandoffMeta(object);
  if (!meta || meta.expiresAt <= now()) {
    background(deleteDoc(bucket, id));
    return null;
  }
  return meta;
}

/** A send claim older than this, still pending, belongs to a request that died. */
const SEND_CLAIM_TTL_MS = 60_000;

/**
 * Claims the one email to the next signer: creates the `sent` marker as
 * pending. Returns 'sent' when the email went out, 'pending' while another
 * send is running.
 * A pending claim older than a minute is taken over, so a crash between the
 * claim and the email does not block the sender for good.
 */
export async function claimSend(
  bucket: R2Bucket,
  id: string,
  wrappedKey?: string,
): Promise<'claimed' | 'sent' | 'pending'> {
  // The wrapped key is in the claim already: the next signer can sign before markSent runs.
  const claim = JSON.stringify({ state: 'pending', at: now(), ...(wrappedKey ? { wrappedKey } : {}) });
  if (await bucket.put(keys.sent(id), claim, { onlyIf: CREATE_ONLY })) return 'claimed';
  const existing = await bucket.get(keys.sent(id));
  // Released between the two reads: another send is deciding.
  if (!existing) return 'pending';
  const value = (await existing.json().catch(() => null)) as { state?: unknown; at?: unknown } | null;
  if (value?.state !== 'pending') return 'sent';
  const stale = typeof value.at === 'number' && value.at < now() - SEND_CLAIM_TTL_MS;
  if (!stale) return 'pending';
  return (await bucket.put(keys.sent(id), claim, { onlyIf: { etagMatches: existing.etag } })) !== null ? 'claimed' : 'pending';
}

export async function markSent(bucket: R2Bucket, id: string, wrappedKey?: string): Promise<void> {
  await bucket.put(keys.sent(id), JSON.stringify({ state: 'sent', at: now(), ...(wrappedKey ? { wrappedKey } : {}) }));
}

/** The wrapped key kept with the `sent` marker, or undefined when there is none or it is not well formed. */
export async function readSentWrappedKey(bucket: R2Bucket, id: string): Promise<string | undefined> {
  const object = await bucket.get(keys.sent(id));
  if (!object) return undefined;
  const value = (await object.json().catch(() => null)) as { wrappedKey?: unknown } | null;
  const parsed = RelayWrappedKey.safeParse(value?.wrappedKey);
  return parsed.success ? parsed.data : undefined;
}

export async function releaseSend(bucket: R2Bucket, id: string): Promise<void> {
  await bucket.delete(keys.sent(id));
}

export interface CodeGate {
  codeHash: string;
  attempts: number;
  expiresAt: number;
}

export interface FinalGate extends CodeGate {
  to: string;
  /** The document key wrapped with the passphrase, when one was set (issue #105). */
  wrappedKey?: string;
}

/** A small JSON record and its etag, or null when missing or expired. */
async function readGate<T extends CodeGate>(
  bucket: R2Bucket,
  key: string,
  onExpired: () => Promise<void>,
  background: Background,
): Promise<{ value: T; etag: string } | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  let value: T;
  try {
    value = (await object.json()) as T;
  } catch {
    background(onExpired());
    return null;
  }
  if (
    typeof value?.codeHash !== 'string' ||
    typeof value.attempts !== 'number' ||
    typeof value.expiresAt !== 'number' ||
    value.expiresAt <= now()
  ) {
    background(onExpired());
    return null;
  }
  return { value, etag: object.etag };
}

export function readLoginGate(bucket: R2Bucket, emailHash: string, background: Background) {
  const key = keys.login(emailHash);
  return readGate<CodeGate>(bucket, key, () => bucket.delete(key), background);
}

export function readFinalGate(bucket: R2Bucket, id: string, background: Background) {
  return readGate<FinalGate>(bucket, keys.finalGate(id), () => deleteDoc(bucket, id), background);
}

/**
 * Counts one attempt before the code is compared: a compare-and-swap on the
 * record's etag. Of several parallel guesses against one version, only one
 * gets to compare, so the attempt limit holds. Returns the new attempt count,
 * or null when another request changed the record first.
 */
export async function reserveAttempt<T extends CodeGate>(
  bucket: R2Bucket,
  key: string,
  gate: { value: T; etag: string },
): Promise<number | null> {
  const attempts = gate.value.attempts + 1;
  const written = await bucket.put(key, JSON.stringify({ ...gate.value, attempts }), {
    onlyIf: { etagMatches: gate.etag },
  });
  return written ? attempts : null;
}
