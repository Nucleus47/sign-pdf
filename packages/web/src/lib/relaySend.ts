/**
 * Email the hand-off to the next signer through the relay (issue #65): encrypt
 * the packet on this device, upload the ciphertext, then ask the relay to
 * email the link. No DOM; the relay client is passed in.
 *
 * The key leaves this device in one request only, the body of `/send`. The
 * sign view keeps it in localStorage with the ciphertext before the upload, so
 * the document can be sent again (sentStore.ts, issue #98); here it is written
 * again with the relay's expiry after `/send` succeeded.
 */
import { RELAY_MAX_BLOB_BYTES, RelayPassphrase } from '@sign-pdf/spec';
import { deriveDocKey, encryptBlob, generateDocId, generateKey, keyToFragment, wrapKey } from './relayCrypto.ts';
import type { RelayClient, RelayResult, RelaySession } from './relayClient.ts';
import { RELAY_NAME_MAX, saveRelayEntry } from './relayStore.ts';

/** An encrypted hand-off, kept in memory so a failed step can be tried again as it is. */
export interface PreparedHandoff {
  id: string;
  /** The key's 43 base64url characters. */
  key: string;
  blob: Uint8Array;
  to: string;
  password: boolean;
  /** The key wrapped with the passphrase (80 base64url characters); set exactly when `password` is true. */
  wrappedKey?: string;
  /** Set once the relay stored the blob. */
  expiresAt?: string;
}

export type PrepareResult = { ok: true; prepared: PreparedHandoff } | { ok: false; tooLarge: true; bytes: number };

/**
 * Encrypt the packet text for a new document id, and wrap the key with the
 * passphrase when there is one. `password` is undefined for none; one that
 * RelayPassphrase refuses (under 8 characters) throws TypeError.
 */
export async function prepareHandoff(packetText: string, to: string, password?: string): Promise<PrepareResult> {
  if (password !== undefined && !RelayPassphrase.safeParse(password).success) {
    throw new TypeError('The passphrase is too short or too long.');
  }
  const id = generateDocId();
  const raw = generateKey();
  const docKey = await deriveDocKey(raw, id, password);
  const blob = await encryptBlob(docKey, id, 'handoff', new TextEncoder().encode(packetText));
  if (blob.byteLength > RELAY_MAX_BLOB_BYTES) return { ok: false, tooLarge: true, bytes: blob.byteLength };
  const prepared: PreparedHandoff = { id, key: keyToFragment(raw), blob, to, password: password !== undefined };
  if (password !== undefined) prepared.wrappedKey = await wrapKey(raw, id, password);
  return { ok: true, prepared };
}

/** Which request failed, for the words on screen. */
export type DeliverStep = 'upload' | 'send';

export type DeliverResult =
  | { ok: true; id: string; expiresAt: string; stored: boolean }
  | (Extract<RelayResult<never>, { ok: false }> & { step: DeliverStep });

/**
 * Upload (unless done before) and send. `prepared` is updated in place with
 * the upload's expiry, so a retry after a failed send does not upload again.
 */
export async function deliverHandoff(
  client: RelayClient,
  session: RelaySession,
  prepared: PreparedHandoff,
  storage: Parameters<typeof saveRelayEntry>[0],
  /** The file name for the signed PDF that comes back; kept with the key. */
  fileName?: string,
): Promise<DeliverResult> {
  if (prepared.expiresAt === undefined) {
    const uploaded = await client.uploadHandoff(session, {
      id: prepared.id,
      to: prepared.to,
      password: prepared.password,
      blob: prepared.blob,
    });
    if (!uploaded.ok) return { ...uploaded, step: 'upload' };
    prepared.expiresAt = uploaded.value.expiresAt;
  }
  const sent = await client.send(session, prepared.id, prepared.key, prepared.wrappedKey);
  // A retry after an answer that was lost: the relay already emailed the next signer.
  if (!sent.ok && sent.code !== 'already-sent') return { ...sent, step: 'send' };
  const stored = saveRelayEntry(storage, prepared.id, {
    k: prepared.key,
    p: prepared.password,
    exp: prepared.expiresAt,
    to: prepared.to,
    ...(fileName && fileName.length <= RELAY_NAME_MAX ? { n: fileName } : {}),
  });
  return { ok: true, id: prepared.id, expiresAt: prepared.expiresAt, stored };
}
