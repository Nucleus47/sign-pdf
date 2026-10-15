/**
 * The first signer collects the signed PDF (docs/relay.md, issue #71). The
 * return link `#relay=<id>` has no key: the device that sent kept it
 * (relayStore.ts). On another device, the key comes back wrapped with the
 * passphrase and is unwrapped here (issue #105).
 * The 6-digit code from the email unlocks the encrypted final on the relay;
 * the key decrypts it here. No DOM; the relay client is passed in.
 *
 * The key, the wrapped key and the password stay in memory and go into no request. No key,
 * code or password is ever put in an error or a report.
 */
import { RelayCryptoError, decryptBlob, deriveDocKey, keyFromFragment, keyToFragment, unwrapKey } from './relayCrypto.ts';
import type { RelayClient, RelayErrorCode } from './relayClient.ts';
import type { RelayEntry } from './relayStore.ts';

/** The file name when the device kept none. */
export const RELAY_FINAL_FALLBACK_NAME = 'signed.pdf';

/** What the code card says when the relay did not hand over the signed PDF. */
export const RELAY_COLLECT_TEXT: Readonly<Partial<Record<RelayErrorCode, string>>> = {
  'bad-code': 'Wrong code. Check the code in the email, then try again. After five wrong codes, the server deletes the signed PDF.',
  'not-found':
    'The signed PDF is no longer on the server. It expired, or it was deleted after five wrong codes. Ask the signer for the PDF; they downloaded a copy.',
  'rate-limited': 'Too many tries. Wait a minute, then try again.',
  unreachable: 'The service did not answer. Check your connection, then try again.',
  'too-large': 'The signed PDF is too large to download on this page. Ask the signer for the PDF.',
  'not-available': 'Signed documents cannot be collected on this server.',
};
const COLLECT_FALLBACK = 'The service had a problem. Try again later.';

export const RELAY_FINAL_DECRYPT_TEXT = {
  'relay-decrypt-failed': 'Could not open. Check the password.',
  'relay-decrypt-failed-no-password': 'Could not open. The signed PDF on the server was changed or damaged.',
  'relay-blob-format': 'Could not open. The signed PDF on the server is not in the expected format.',
} as const;

export const CODE_PATTERN = /^\d{6}$/;

export type FinalFetchOutcome =
  | { ok: true; blob: Uint8Array; wrappedKey?: string }
  | { ok: false; code: RelayErrorCode; message: string; status?: number };

/** Get the encrypted signed PDF. Each call uses one of the five code attempts. */
export async function fetchRelayFinal(client: RelayClient, id: string, code: string): Promise<FinalFetchOutcome> {
  const result = await client.fetchFinal(id, code);
  if (result.ok) {
    const { blob, wrappedKey } = result.value;
    return wrappedKey === undefined ? { ok: true, blob } : { ok: true, blob, wrappedKey };
  }
  const outcome: FinalFetchOutcome = {
    ok: false,
    code: result.code,
    message: RELAY_COLLECT_TEXT[result.code] ?? COLLECT_FALLBACK,
  };
  return result.status === undefined ? outcome : { ...outcome, status: result.status };
}

export type FinalDecryptOutcome =
  | { ok: true; pdf: Uint8Array }
  | { ok: false; code: 'relay-decrypt-failed' | 'relay-blob-format'; message: string };

/** Decrypt the signed PDF with the kept key and the optional password (purpose `final`). */
export async function decryptRelayFinal(
  id: string,
  entry: Pick<RelayEntry, 'k'>,
  blob: Uint8Array,
  password: string | undefined,
): Promise<FinalDecryptOutcome> {
  const key = keyFromFragment(entry.k);
  if (!key) return { ok: false, code: 'relay-blob-format', message: RELAY_FINAL_DECRYPT_TEXT['relay-blob-format'] };
  try {
    const docKey = await deriveDocKey(key, id, password);
    return { ok: true, pdf: await decryptBlob(docKey, id, 'final', blob) };
  } catch (error) {
    if (error instanceof RelayCryptoError && error.code === 'relay-blob-format') {
      return { ok: false, code: 'relay-blob-format', message: RELAY_FINAL_DECRYPT_TEXT['relay-blob-format'] };
    }
    return {
      ok: false,
      code: 'relay-decrypt-failed',
      message:
        RELAY_FINAL_DECRYPT_TEXT[password === undefined ? 'relay-decrypt-failed-no-password' : 'relay-decrypt-failed'],
    };
  }
}

export const RELAY_UNWRAP_TEXT = {
  'relay-unwrap-failed': 'Wrong passphrase. Check it, then try again. This does not use a code attempt.',
  'relay-blob-format': 'Could not open. The key on the server is not in the expected format.',
} as const;

export type UnwrapOutcome =
  | { ok: true; entry: Pick<RelayEntry, 'k'> }
  | { ok: false; code: 'relay-unwrap-failed' | 'relay-blob-format'; message: string };

/**
 * The document key on a device that did not send the document: unwrap it
 * with the passphrase (issue #105). Runs on this device only, so a wrong
 * passphrase uses no code attempt. The result goes to decryptRelayFinal with
 * the same passphrase, which also went into the document key.
 */
export async function unwrapRelayKey(id: string, wrappedKey: string, passphrase: string): Promise<UnwrapOutcome> {
  try {
    return { ok: true, entry: { k: keyToFragment(await unwrapKey(wrappedKey, id, passphrase)) } };
  } catch (error) {
    const code = error instanceof RelayCryptoError && error.code === 'relay-blob-format' ? 'relay-blob-format' : 'relay-unwrap-failed';
    return { ok: false, code, message: RELAY_UNWRAP_TEXT[code] };
  }
}
