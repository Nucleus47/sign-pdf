// @vitest-environment node
// Node's WebCrypto, the same API the browser has; jsdom has no crypto.subtle.
import { createCipheriv, createDecipheriv, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto';
import { RelayDocId } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import {
  RELAY_PBKDF2_ITERATIONS,
  RelayCryptoError,
  decryptBlob,
  deriveDocKey,
  encryptBlob,
  generateDocId,
  generateKey,
  keyFromFragment,
  keyToFragment,
  unwrapKey,
  wrapKey,
} from './relayCrypto.ts';

const ID = 'AAECAwQFBgcICQoLDA0ODw'; // bytes 0..15
const OTHER_ID = 'EBESExQVFhcYGRobHB0eHw'; // bytes 16..31
const text = (value: string) => new TextEncoder().encode(value);
const PLAIN = text('{"kind":"sign-pdf-packet","note":"synthetic"}\n');

async function failure(promise: Promise<unknown>): Promise<RelayCryptoError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RelayCryptoError);
  return error as RelayCryptoError;
}

/** The spec in the file header, written out again with node:crypto, to decrypt what the browser code wrote. */
function referenceDecrypt(key: Uint8Array, id: string, purpose: string, blob: Uint8Array, password?: string): Buffer {
  const salt = password
    ? pbkdf2Sync(password.normalize('NFC'), `sign-pdf-relay/${id}`, RELAY_PBKDF2_ITERATIONS, 32, 'sha256')
    : Buffer.alloc(0);
  const docKey = Buffer.from(hkdfSync('sha256', key, salt, 'sign-pdf-relay/v1/doc-key', 32));
  const blobKey = Buffer.from(hkdfSync('sha256', docKey, Buffer.alloc(0), `sign-pdf-relay/v1/${purpose}`, 32));
  expect(Buffer.from(blob.subarray(0, 4)).toString('ascii')).toBe('SPR1');
  const decipher = createDecipheriv('aes-256-gcm', blobKey, blob.subarray(4, 16));
  decipher.setAAD(Buffer.from(`sign-pdf-relay/v1|${id}|${purpose}`));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(16, blob.length - 16)), decipher.final()]);
}

/** A blob encrypted with one purpose's key and another (or the same) purpose's AAD, with node:crypto. */
function referenceEncrypt(key: Uint8Array, id: string, keyPurpose: string, aadPurpose: string, plain: Uint8Array) {
  const docKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'sign-pdf-relay/v1/doc-key', 32));
  const blobKey = Buffer.from(hkdfSync('sha256', docKey, Buffer.alloc(0), `sign-pdf-relay/v1/${keyPurpose}`, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', blobKey, nonce);
  cipher.setAAD(Buffer.from(`sign-pdf-relay/v1|${id}|${aadPurpose}`));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return new Uint8Array(Buffer.concat([Buffer.from('SPR1'), nonce, sealed]));
}

describe('key and fragment', () => {
  it('generates 32 random bytes', () => {
    const a = generateKey();
    expect(a).toHaveLength(32);
    expect(keyToFragment(a)).not.toBe(keyToFragment(generateKey()));
  });

  it('round-trips through 43 base64url characters, the same as Node encodes them', () => {
    for (let i = 0; i < 50; i++) {
      const key = generateKey();
      const fragment = keyToFragment(key);
      expect(fragment).toHaveLength(43);
      expect(fragment).toBe(Buffer.from(key).toString('base64url'));
      expect(keyFromFragment(fragment)).toEqual(key);
    }
  });

  it.each([
    ['empty', ''],
    ['42 characters', 'A'.repeat(42)],
    ['44 characters', 'A'.repeat(44)],
    ['padded', `${'A'.repeat(43)}=`],
    ['the standard alphabet', `${'A'.repeat(42)}+`],
    ['a non-canonical last character', `${'A'.repeat(42)}B`],
    ['percent-encoded', `${'A'.repeat(40)}%2D`],
  ])('refuses a fragment that is %s', (_name, fragment) => {
    expect(keyFromFragment(fragment)).toBeNull();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => keyToFragment(new Uint8Array(31))).toThrow(TypeError);
  });

  it('generates random document ids that the relay accepts', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = generateDocId();
      expect(RelayDocId.safeParse(id).success).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });
});

describe('encryptBlob and decryptBlob', () => {
  it('round-trip without a password, in the documented format', async () => {
    const key = generateKey();
    const docKey = await deriveDocKey(key, ID);
    const blob = await encryptBlob(docKey, ID, 'handoff', PLAIN);
    expect(blob).toHaveLength(4 + 12 + PLAIN.length + 16);
    expect(await decryptBlob(docKey, ID, 'handoff', blob)).toEqual(PLAIN);
    // A second device starting from the link alone gets the same key.
    const again = await deriveDocKey(keyFromFragment(keyToFragment(key)) ?? new Uint8Array(), ID);
    expect(await decryptBlob(again, ID, 'handoff', blob)).toEqual(PLAIN);
    expect(new Uint8Array(referenceDecrypt(key, ID, 'handoff', blob))).toEqual(PLAIN);
  });

  it('round-trip with a password, and a wrong or missing password fails', async () => {
    const key = generateKey();
    const docKey = await deriveDocKey(key, ID, 'correct horse');
    const blob = await encryptBlob(docKey, ID, 'final', PLAIN);
    expect(await decryptBlob(await deriveDocKey(key, ID, 'correct horse'), ID, 'final', blob)).toEqual(PLAIN);
    expect(new Uint8Array(referenceDecrypt(key, ID, 'final', blob, 'correct horse'))).toEqual(PLAIN);

    const wrong = await failure(decryptBlob(await deriveDocKey(key, ID, 'correct horsf'), ID, 'final', blob));
    expect(wrong.code).toBe('relay-decrypt-failed');
    const missing = await failure(decryptBlob(await deriveDocKey(key, ID), ID, 'final', blob));
    expect(missing.code).toBe('relay-decrypt-failed');
    // The message is the same whatever the cause.
    expect(missing.message).toBe(wrong.message);
  });

  it('normalizes the password, so a decomposed accent gives the same key', async () => {
    const key = generateKey();
    const blob = await encryptBlob(await deriveDocKey(key, ID, 'café'), ID, 'handoff', PLAIN);
    expect(await decryptBlob(await deriveDocKey(key, ID, 'café'), ID, 'handoff', blob)).toEqual(PLAIN);
  });

  it('gives two different blobs for the same plaintext', async () => {
    const docKey = await deriveDocKey(generateKey(), ID);
    const a = await encryptBlob(docKey, ID, 'handoff', PLAIN);
    const b = await encryptBlob(docKey, ID, 'handoff', PLAIN);
    expect(a.subarray(4, 16)).not.toEqual(b.subarray(4, 16));
    expect(a).not.toEqual(b);
  });

  it('fails for another id, another purpose or a wrong key', async () => {
    const key = generateKey();
    const docKey = await deriveDocKey(key, ID);
    const blob = await encryptBlob(docKey, ID, 'handoff', PLAIN);

    // The same K under another id: both the doc key and the AAD differ.
    const otherDoc = await failure(decryptBlob(await deriveDocKey(key, OTHER_ID), OTHER_ID, 'handoff', blob));
    expect(otherDoc.code).toBe('relay-decrypt-failed');
    // The right doc key, but the blob claimed for another id: only the AAD differs.
    expect((await failure(decryptBlob(docKey, OTHER_ID, 'handoff', blob))).code).toBe('relay-decrypt-failed');
    expect((await failure(decryptBlob(docKey, ID, 'final', blob))).code).toBe('relay-decrypt-failed');
    const stranger = await deriveDocKey(generateKey(), ID);
    expect((await failure(decryptBlob(stranger, ID, 'handoff', blob))).code).toBe('relay-decrypt-failed');
  });

  it('fails when any byte after the magic is flipped, or the blob is cut', async () => {
    const docKey = await deriveDocKey(generateKey(), ID);
    const blob = await encryptBlob(docKey, ID, 'handoff', PLAIN);
    for (const at of [4, 15, 16, 16 + Math.floor(PLAIN.length / 2), blob.length - 1]) {
      const changed = blob.slice();
      changed[at] = (changed[at] ?? 0) ^ 1;
      expect((await failure(decryptBlob(docKey, ID, 'handoff', changed))).code, `byte ${at}`).toBe(
        'relay-decrypt-failed',
      );
    }
    expect((await failure(decryptBlob(docKey, ID, 'handoff', blob.slice(0, -1)))).code).toBe('relay-decrypt-failed');
  });

  it('reports a bad magic or a short blob as a format problem', async () => {
    const docKey = await deriveDocKey(generateKey(), ID);
    const blob = await encryptBlob(docKey, ID, 'handoff', PLAIN);
    for (const [name, bad] of [
      ['SPR2', Uint8Array.from([...text('SPR2'), ...blob.subarray(4)])],
      ['a PDF', Uint8Array.from([...text('%PDF'), ...blob.subarray(4)])],
      ['too short', blob.slice(0, 31)],
      ['empty', new Uint8Array(0)],
    ] as const) {
      expect((await failure(decryptBlob(docKey, ID, 'handoff', bad))).code, name).toBe('relay-blob-format');
    }
    // The shortest well-formed blob (empty plaintext) still opens.
    const empty = await encryptBlob(docKey, ID, 'handoff', new Uint8Array(0));
    expect(empty).toHaveLength(32);
    expect(await decryptBlob(docKey, ID, 'handoff', empty)).toEqual(new Uint8Array(0));
  });

  it('keeps the purposes apart by key alone and by AAD alone', async () => {
    const key = generateKey();
    const docKey = await deriveDocKey(key, ID);
    // The handoff AAD under the final key: only the key is wrong for 'handoff'.
    const wrongKey = referenceEncrypt(key, ID, 'final', 'handoff', PLAIN);
    expect((await failure(decryptBlob(docKey, ID, 'handoff', wrongKey))).code).toBe('relay-decrypt-failed');
    // The final AAD under the handoff key: only the AAD is wrong for 'handoff'.
    const wrongAad = referenceEncrypt(key, ID, 'handoff', 'final', PLAIN);
    expect((await failure(decryptBlob(docKey, ID, 'handoff', wrongAad))).code).toBe('relay-decrypt-failed');
    // The control: the matching key and AAD open.
    expect(await decryptBlob(docKey, ID, 'handoff', referenceEncrypt(key, ID, 'handoff', 'handoff', PLAIN))).toEqual(
      PLAIN,
    );
  });

  it('opens the fixed known-answer vectors', async () => {
    // K = bytes 0..31, id = bytes 0..15, nonce = a0..ab. Other implementations can reuse these.
    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    const plain = text('sign-pdf relay test vector\n');
    const handoff = Buffer.from(
      '53505231a0a1a2a3a4a5a6a7a8a9aaaba7805370a34b6bc56694d5c216e92f136c5dfef4c27264b8b5a99036d8baea9ef0e073ffd57cfa6541a0c2',
      'hex',
    );
    const final = Buffer.from(
      '53505231a0a1a2a3a4a5a6a7a8a9aaabfccc8246e14e912f5656ae2c38ad6f47b1020f879277212f070b443da268aff0d0ad4e643a694c27ac3073',
      'hex',
    );
    expect(await decryptBlob(await deriveDocKey(key, ID), ID, 'handoff', handoff)).toEqual(plain);
    expect(await decryptBlob(await deriveDocKey(key, ID, 'correct horse'), ID, 'final', final)).toEqual(plain);
  });

  it('refuses an id or a purpose that is not one, and an empty password', async () => {
    await expect(deriveDocKey(generateKey(), ID, '')).rejects.toThrow(TypeError);
    await expect(deriveDocKey(generateKey(), 'not-an-id')).rejects.toThrow(TypeError);
    await expect(deriveDocKey(new Uint8Array(16), ID)).rejects.toThrow(TypeError);
    const docKey = await deriveDocKey(generateKey(), ID);
    await expect(encryptBlob(docKey, `${ID}|final`, 'handoff', PLAIN)).rejects.toThrow(TypeError);
    // Deliberately wrong: the cast stands in for input that skipped type checking.
    await expect(encryptBlob(docKey, ID, 'other' as 'final', PLAIN)).rejects.toThrow(TypeError);
  });
});

describe('wrapKey and unwrapKey', () => {
  const PASS = 'correct horse';

  /** The wrap in the file header, written out again with node:crypto. */
  function referenceUnwrap(wrapped: string, id: string, passphrase: string): Buffer {
    const bytes = Buffer.from(wrapped, 'base64url');
    const w = pbkdf2Sync(passphrase.normalize('NFC'), `sign-pdf-relay/wrap/${id}`, RELAY_PBKDF2_ITERATIONS, 32, 'sha256');
    const key = Buffer.from(hkdfSync('sha256', w, Buffer.alloc(0), 'sign-pdf-relay/v1/wrap-key', 32));
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`sign-pdf-relay/v1|${id}|wrap`));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
  }

  it('round-trips K, and matches the spec in the file header', async () => {
    const key = generateKey();
    const wrapped = await wrapKey(key, ID, PASS);
    expect(wrapped).toMatch(/^[A-Za-z0-9_-]{80}$/);
    expect(await unwrapKey(wrapped, ID, PASS)).toEqual(key);
    expect(new Uint8Array(referenceUnwrap(wrapped, ID, PASS))).toEqual(key);
  });

  it('takes a fresh nonce each time', async () => {
    const key = generateKey();
    expect(await wrapKey(key, ID, PASS)).not.toBe(await wrapKey(key, ID, PASS));
  });

  it('opens with the same passphrase in another Unicode form (NFC)', async () => {
    const key = generateKey();
    const wrapped = await wrapKey(key, ID, 'caf\u00e9-latte');
    expect(await unwrapKey(wrapped, ID, 'cafe\u0301-latte')).toEqual(key);
  });

  it('refuses a wrong passphrase', async () => {
    const wrapped = await wrapKey(generateKey(), ID, PASS);
    expect((await failure(unwrapKey(wrapped, ID, 'correct horsf'))).code).toBe('relay-unwrap-failed');
  });

  it('refuses another document id (salt and AAD)', async () => {
    const wrapped = await wrapKey(generateKey(), ID, PASS);
    expect((await failure(unwrapKey(wrapped, OTHER_ID, PASS))).code).toBe('relay-unwrap-failed');
  });

  it('refuses a changed wrapped key', async () => {
    const wrapped = await wrapKey(generateKey(), ID, PASS);
    const flipped = `${wrapped.slice(0, 40)}${wrapped[40] === 'A' ? 'B' : 'A'}${wrapped.slice(41)}`;
    expect((await failure(unwrapKey(flipped, ID, PASS))).code).toBe('relay-unwrap-failed');
  });

  it('binds the purpose: the same key under the hand-off AAD does not open', async () => {
    // A blob AAD ("|handoff") is not the wrap AAD ("|wrap"), so a wrapped key is not a blob and back.
    const key = generateKey();
    const wrapped = Buffer.from(await wrapKey(key, ID, PASS), 'base64url');
    const w = pbkdf2Sync(PASS, `sign-pdf-relay/wrap/${ID}`, RELAY_PBKDF2_ITERATIONS, 32, 'sha256');
    const wk = Buffer.from(hkdfSync('sha256', w, Buffer.alloc(0), 'sign-pdf-relay/v1/wrap-key', 32));
    const decipher = createDecipheriv('aes-256-gcm', wk, wrapped.subarray(0, 12));
    decipher.setAAD(Buffer.from(`sign-pdf-relay/v1|${ID}|handoff`));
    decipher.setAuthTag(wrapped.subarray(wrapped.length - 16));
    decipher.update(wrapped.subarray(12, wrapped.length - 16));
    expect(() => decipher.final()).toThrow();
  });

  it('refuses text that is not a wrapped key, before any key work', async () => {
    expect((await failure(unwrapKey('A'.repeat(79), ID, PASS))).code).toBe('relay-blob-format');
  });

  it('refuses an empty passphrase, a short key and a bad id', async () => {
    await expect(wrapKey(generateKey(), ID, '')).rejects.toThrow(TypeError);
    await expect(wrapKey(new Uint8Array(31), ID, PASS)).rejects.toThrow(TypeError);
    await expect(wrapKey(generateKey(), 'nope', PASS)).rejects.toThrow(TypeError);
  });
});
