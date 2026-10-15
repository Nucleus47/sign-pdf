/**
 * The next signer's side of the relay (docs/relay.md, issue #65): open an
 * emailed document and send the signed PDF back. No DOM; the relay client is
 * passed in.
 *
 * The link's key and the password stay in memory. Only the derived document
 * key (a non-extractable CryptoKey) goes on with the sign job, to encrypt the
 * final. No key, id or password is ever put in an error or a report.
 */
import { RELAY_MAX_BLOB_BYTES } from '@sign-pdf/spec';
import { RelayCryptoError, decryptBlob, deriveDocKey, encryptBlob, keyFromFragment } from './relayCrypto.ts';
import type { FetchedHandoff, RelayClient, RelayErrorCode } from './relayClient.ts';
import type { PostResult } from './transport.ts';

/** What the open card says when the relay did not hand over the document. */
export const RELAY_OPEN_TEXT: Readonly<Partial<Record<RelayErrorCode, string>>> = {
  'not-found': 'This link has expired or was already used.',
  'rate-limited': 'Too many tries. Wait a minute, then try again.',
  unreachable: 'The service did not answer. Check your connection, then try again.',
  'too-large': 'The document is too large to open on this page.',
  'not-available': 'Emailed documents cannot be opened on this server.',
};
const OPEN_FALLBACK = 'The service had a problem. Try again later.';

/** What the open card says when the document did not decrypt. */
export const RELAY_DECRYPT_TEXT = {
  'relay-decrypt-failed': 'Could not open. Check the password.',
  'relay-decrypt-failed-no-password': 'Could not open. The link is damaged or the document was changed.',
  'relay-blob-format': 'Could not open. The document from the link is not in the expected format.',
} as const;

export type FetchOutcome =
  | { ok: true; fetched: FetchedHandoff }
  | { ok: false; code: RelayErrorCode; message: string; status?: number };

/** Get the encrypted hand-off. The caller keeps it, so a password retry does not fetch again. */
export async function fetchRelayHandoff(client: RelayClient, id: string): Promise<FetchOutcome> {
  const result = await client.fetchHandoff(id);
  if (result.ok) return { ok: true, fetched: result.value };
  const outcome: FetchOutcome = { ok: false, code: result.code, message: RELAY_OPEN_TEXT[result.code] ?? OPEN_FALLBACK };
  return result.status === undefined ? outcome : { ...outcome, status: result.status };
}

export type DecryptOutcome =
  | { ok: true; docKey: CryptoKey; plaintext: Uint8Array }
  | { ok: false; code: 'relay-decrypt-failed' | 'relay-blob-format'; message: string };

/**
 * Decrypt the hand-off. A wrong password and a changed blob both give
 * `relay-decrypt-failed`: AES-GCM cannot tell them apart, and neither can the page.
 */
export async function decryptRelayHandoff(
  id: string,
  keyText: string,
  blob: Uint8Array,
  password: string | undefined,
): Promise<DecryptOutcome> {
  const key = keyFromFragment(keyText);
  if (!key) return { ok: false, code: 'relay-blob-format', message: RELAY_DECRYPT_TEXT['relay-blob-format'] };
  try {
    const docKey = await deriveDocKey(key, id, password);
    const plaintext = await decryptBlob(docKey, id, 'handoff', blob);
    return { ok: true, docKey, plaintext };
  } catch (error) {
    if (error instanceof RelayCryptoError && error.code === 'relay-blob-format') {
      return { ok: false, code: 'relay-blob-format', message: RELAY_DECRYPT_TEXT['relay-blob-format'] };
    }
    return {
      ok: false,
      code: 'relay-decrypt-failed',
      message: RELAY_DECRYPT_TEXT[password === undefined ? 'relay-decrypt-failed-no-password' : 'relay-decrypt-failed'],
    };
  }
}

/** What the signed screen says when the final did not reach the relay. `requester` is the first signer's name. */
function finalText(code: RelayErrorCode, requester: string): string {
  switch (code) {
    case 'too-large':
      return `The signed PDF is too large to send back. Download it and send it to ${requester} yourself.`;
    case 'not-found':
      return `The link has expired, so the signed PDF cannot be sent back. Download it and send it to ${requester} yourself.`;
    case 'email-failed':
      return `The email to ${requester} could not be sent. Try again.`;
    case 'rate-limited':
      return 'Too many tries. Wait a minute, then try again.';
    case 'unreachable':
      return 'The service did not answer. Check your connection, then try again.';
    default:
      return OPEN_FALLBACK;
  }
}

/**
 * Encrypt the signed PDF with purpose `final` and upload it once. A final that
 * is already there counts as sent: an earlier try went through.
 */
export async function sendRelayFinal(
  client: RelayClient,
  relay: { id: string; docKey: CryptoKey; requester: string },
  pdf: Uint8Array,
): Promise<PostResult> {
  let blob: Uint8Array;
  try {
    blob = await encryptBlob(relay.docKey, relay.id, 'final', pdf);
  } catch {
    return { ok: false, code: 'relay-encrypt-failed', error: 'The signed PDF could not be encrypted on this device.' };
  }
  if (blob.byteLength > RELAY_MAX_BLOB_BYTES) {
    return { ok: false, code: 'too-large', error: finalText('too-large', relay.requester) };
  }
  const result = await client.uploadFinal(relay.id, blob);
  // A final already there is taken as this one: an earlier try whose answer was
  // lost. Only someone holding the link's key could have made another, and the
  // first signer sees in the audit record who signed.
  if (result.ok || result.code === 'already-sent') return { ok: true };
  const failed: PostResult = { ok: false, code: result.code, error: finalText(result.code, relay.requester) };
  return result.status === undefined ? failed : { ...failed, status: result.status };
}
