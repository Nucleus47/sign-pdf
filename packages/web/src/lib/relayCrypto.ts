/**
 * End-to-end encryption for the relay (issue #65): the browser encrypts the
 * hand-off packet and the final PDF before they leave the device, and the
 * relay server stores ciphertext only. WebCrypto only; no DOM, no network.
 *
 *   K          32 random bytes; travels only in the link fragment (`k=`)
 *   P          PBKDF2-SHA256(NFC(password), salt "sign-pdf-relay/" + id, 600 000 iterations, 32 bytes)
 *   docKey     HKDF-SHA256(ikm K, salt P or empty, info "sign-pdf-relay/v1/doc-key")
 *   blobKey    HKDF-SHA256(ikm docKey, salt empty, info "sign-pdf-relay/v1/" + purpose): AES-256-GCM
 *   AAD        "sign-pdf-relay/v1|" + id + "|" + purpose
 *   blob       "SPR1" | nonce (12 random bytes) | ciphertext + 16-byte tag
 *
 * With a passphrase, K is also wrapped so the first signer can collect the
 * signed PDF on any device (issue #105):
 *
 *   W          PBKDF2-SHA256(NFC(passphrase), salt "sign-pdf-relay/wrap/" + id, 600 000 iterations, 32 bytes)
 *   wrapKey    HKDF-SHA256(ikm W, salt empty, info "sign-pdf-relay/v1/wrap-key"): AES-256-GCM
 *   wrapped    nonce (12 random bytes) | AES-GCM(K, AAD "sign-pdf-relay/v1|" + id + "|wrap") + 16-byte tag,
 *              as 80 base64url characters
 *
 * The relay stores the wrapped key. Anyone who holds it can try passphrases
 * offline; the PBKDF2 cost and the 8-character minimum slow that down.
 *
 * The AAD binds a blob to its document id and its purpose, so a blob cannot be
 * moved to another id or swapped between the hand-off and the final PDF. Each
 * purpose has its own key, and every encryption takes a fresh random nonce.
 */
import { RelayDocId, RelayKey, RelayWrappedKey } from '@sign-pdf/spec';

/** Bytes of K. */
export const RELAY_KEY_BYTES = 32;
/** PBKDF2 iterations for the optional password (OWASP 2023 figure for PBKDF2-HMAC-SHA256). */
export const RELAY_PBKDF2_ITERATIONS = 600_000;

export type RelayPurpose = 'handoff' | 'final';
const PURPOSES: readonly RelayPurpose[] = ['handoff', 'final'];

const MAGIC = new TextEncoder().encode('SPR1');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * - `relay-blob-format`: the bytes are not a relay blob of this version (wrong
 *   magic, or too short).
 * - `relay-decrypt-failed`: a relay blob that does not open with this key. The
 *   cause (wrong link, wrong password, damaged or swapped file) is not told
 *   apart: authenticated encryption cannot tell, and must not try.
 * - `relay-unwrap-failed`: the wrapped key does not open with this passphrase
 *   and id (a wrong passphrase, or a changed wrapped key).
 */
export type RelayCryptoErrorCode = 'relay-blob-format' | 'relay-decrypt-failed' | 'relay-unwrap-failed';

export class RelayCryptoError extends Error {
  override readonly name = 'RelayCryptoError';
  constructor(
    readonly code: RelayCryptoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** A copy in a plain ArrayBuffer: WebCrypto rejects views over a SharedArrayBuffer. */
const copy = (bytes: Uint8Array) => new Uint8Array(bytes);

function checkId(id: string): void {
  if (!RelayDocId.safeParse(id).success) throw new TypeError('Not a relay document id.');
}

function checkPurpose(purpose: RelayPurpose): void {
  if (!PURPOSES.includes(purpose)) throw new TypeError('Not a relay blob purpose.');
}

/** A new random K. */
export function generateKey(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(RELAY_KEY_BYTES));
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** K as the 43 unpadded base64url characters of a link's `k=`. */
export function keyToFragment(key: Uint8Array): string {
  if (key.length !== RELAY_KEY_BYTES) throw new TypeError('A relay key is 32 bytes.');
  return toBase64url(key);
}

/**
 * A new random document id: 128 bits as 22 base64url characters. The browser
 * chooses it, because the encryption binds the blob to its id before the
 * upload; the relay refuses an id that is in use.
 */
export function generateDocId(): string {
  return toBase64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** Unpadded base64url; the unused low bits of the last character are zero (canonical). */
function toBase64url(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(value >> bits) & 63];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (6 - bits)) & 63];
  return out;
}

/** K from a link's `k=`, or null unless it is exactly 43 canonical base64url characters. */
export function keyFromFragment(text: string): Uint8Array | null {
  if (!RelayKey.safeParse(text).success) return null;
  return fromBase64url(text, RELAY_KEY_BYTES);
}

/** `length` bytes from unpadded base64url the caller has already checked. */
function fromBase64url(text: string, length: number): Uint8Array {
  const key = new Uint8Array(length);
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of text) {
    value = (value << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      key[at++] = (value >> bits) & 255;
    }
    value &= (1 << bits) - 1;
  }
  return key;
}

/**
 * The document key, from K and the optional password. Without a password the
 * HKDF salt is empty. The password is normalized to Unicode NFC before
 * PBKDF2. The result can only derive the per-purpose blob keys.
 *
 * Throws TypeError for a key that is not 32 bytes, an id that is not one, or
 * an empty password (pass `undefined` for none, so `p=1` can never mean "no
 * password" by accident).
 */
export async function deriveDocKey(key: Uint8Array, id: string, password?: string): Promise<CryptoKey> {
  if (key.length !== RELAY_KEY_BYTES) throw new TypeError('A relay key is 32 bytes.');
  checkId(id);
  if (password === '') throw new TypeError('An empty password is not a password: pass undefined.');
  const subtle = globalThis.crypto.subtle;
  let salt = new Uint8Array(0);
  if (password !== undefined) {
    // NFC, so the same password typed on another device gives the same bytes.
    const secret = await subtle.importKey('raw', utf8(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    const stretched = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(`sign-pdf-relay/${id}`), iterations: RELAY_PBKDF2_ITERATIONS },
      secret,
      256,
    );
    salt = new Uint8Array(stretched);
  }
  const ikm = await subtle.importKey('raw', copy(key), 'HKDF', false, ['deriveBits']);
  const docKey = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8('sign-pdf-relay/v1/doc-key') },
    ikm,
    256,
  );
  return subtle.importKey('raw', docKey, 'HKDF', false, ['deriveKey']);
}

function blobKey(docKey: CryptoKey, purpose: RelayPurpose): Promise<CryptoKey> {
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(`sign-pdf-relay/v1/${purpose}`) },
    docKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const aad = (id: string, purpose: RelayPurpose) => utf8(`sign-pdf-relay/v1|${id}|${purpose}`);

/** Encrypt one blob for document `id`. Two calls with the same input give different blobs. */
export async function encryptBlob(
  docKey: CryptoKey,
  id: string,
  purpose: RelayPurpose,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  checkId(id);
  checkPurpose(purpose);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(id, purpose), tagLength: TAG_BYTES * 8 },
    await blobKey(docKey, purpose),
    copy(plaintext),
  );
  const blob = new Uint8Array(MAGIC.length + NONCE_BYTES + sealed.byteLength);
  blob.set(MAGIC, 0);
  blob.set(nonce, MAGIC.length);
  blob.set(new Uint8Array(sealed), MAGIC.length + NONCE_BYTES);
  return blob;
}

/**
 * Decrypt one blob of document `id`. Throws RelayCryptoError for a blob that
 * does not open, and TypeError for an id or purpose that is not one. The size
 * cap (RELAY_MAX_BLOB_BYTES) is the caller's to check before downloading.
 */
export async function decryptBlob(
  docKey: CryptoKey,
  id: string,
  purpose: RelayPurpose,
  blob: Uint8Array,
): Promise<Uint8Array> {
  checkId(id);
  checkPurpose(purpose);
  if (blob.length < MAGIC.length + NONCE_BYTES + TAG_BYTES || MAGIC.some((byte, i) => blob[i] !== byte)) {
    throw new RelayCryptoError('relay-blob-format', 'The file is not an encrypted sign-pdf document.');
  }
  const nonce = blob.slice(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const sealed = blob.slice(MAGIC.length + NONCE_BYTES);
  const key = await blobKey(docKey, purpose);
  try {
    const opened = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(id, purpose), tagLength: TAG_BYTES * 8 },
      key,
      sealed,
    );
    return new Uint8Array(opened);
  } catch {
    throw new RelayCryptoError(
      'relay-decrypt-failed',
      'The document could not be decrypted. The link or the password is wrong, or the file was changed.',
    );
  }
}

const WRAP_NONCE_BYTES = 12;
const wrapAad = (id: string) => utf8(`sign-pdf-relay/v1|${id}|wrap`);

async function wrappingKey(id: string, passphrase: string): Promise<CryptoKey> {
  checkId(id);
  if (passphrase === '') throw new TypeError('An empty passphrase is not a passphrase.');
  const subtle = globalThis.crypto.subtle;
  const secret = await subtle.importKey('raw', utf8(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const stretched = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(`sign-pdf-relay/wrap/${id}`), iterations: RELAY_PBKDF2_ITERATIONS },
    secret,
    256,
  );
  const ikm = await subtle.importKey('raw', stretched, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('sign-pdf-relay/v1/wrap-key') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * K wrapped with a key from the passphrase, for document `id`: 80 base64url
 * characters (RelayWrappedKey). The length rule for the passphrase
 * (RelayPassphrase) is the caller's to check; here only an empty one is refused.
 */
export async function wrapKey(key: Uint8Array, id: string, passphrase: string): Promise<string> {
  if (key.length !== RELAY_KEY_BYTES) throw new TypeError('A relay key is 32 bytes.');
  const wrapping = await wrappingKey(id, passphrase);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(WRAP_NONCE_BYTES));
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: wrapAad(id), tagLength: TAG_BYTES * 8 },
    wrapping,
    copy(key),
  );
  const out = new Uint8Array(WRAP_NONCE_BYTES + sealed.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(sealed), WRAP_NONCE_BYTES);
  return toBase64url(out);
}

/**
 * K from a wrapped key, the passphrase and the document id. Throws
 * RelayCryptoError `relay-blob-format` for text that is not a wrapped key and
 * `relay-unwrap-failed` for a wrong passphrase, a wrong id or a changed
 * wrapped key. Runs on this device only: a wrong passphrase costs no request.
 */
export async function unwrapKey(wrapped: string, id: string, passphrase: string): Promise<Uint8Array> {
  if (!RelayWrappedKey.safeParse(wrapped).success) {
    throw new RelayCryptoError('relay-blob-format', 'The wrapped key is not in the expected format.');
  }
  const bytes = fromBase64url(wrapped, WRAP_NONCE_BYTES + RELAY_KEY_BYTES + TAG_BYTES);
  const wrapping = await wrappingKey(id, passphrase);
  try {
    const opened = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, WRAP_NONCE_BYTES), additionalData: wrapAad(id), tagLength: TAG_BYTES * 8 },
      wrapping,
      bytes.slice(WRAP_NONCE_BYTES),
    );
    return new Uint8Array(opened);
  } catch {
    throw new RelayCryptoError('relay-unwrap-failed', 'The key could not be unwrapped. The passphrase is wrong.');
  }
}
