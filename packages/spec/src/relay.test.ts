import { describe, expect, it } from 'vitest';
import {
  CreateDocResponse,
  Email,
  LoginBody,
  OkResponse,
  RELAY_MAX_BLOB_BYTES,
  RELAY_PASSPHRASE_MIN,
  RelayPassphrase,
  RelayWrappedKey,
  RelayDocId,
  RelayError,
  RelayKey,
  SendBody,
  SessionResponse,
  VerifyBody,
} from './index.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Canonical unpadded base64url of the bytes (RFC 4648 §5), written out here as a reference. */
function b64u(bytes: number[]): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  bits = bits.padEnd(Math.ceil(bits.length / 6) * 6, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 6) out += ALPHABET[parseInt(bits.slice(i, i + 6), 2)];
  return out;
}
const KEY = b64u(Array.from({ length: 32 }, (_, i) => i * 7));
const ID = b64u(Array.from({ length: 16 }, (_, i) => 255 - i));

describe('relay constants', () => {
  it('caps a blob at 40 MiB', () => {
    expect(RELAY_MAX_BLOB_BYTES).toBe(41_943_040);
  });
});

describe('Email', () => {
  it('trims and lower-cases before checking', () => {
    expect(Email.parse('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it.each(['', 'ada', 'ada@', '@example.com', 'a b@example.com'])('rejects %j', (value) => {
    expect(Email.safeParse(value).success).toBe(false);
  });

  it('rejects an address over 254 characters', () => {
    const long = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.com`;
    expect(long.length).toBe(255);
    expect(Email.safeParse(long).success).toBe(false);
    expect(Email.safeParse(long.slice(1)).success).toBe(true);
  });
});

describe('RelayDocId and RelayKey', () => {
  it('accept canonical base64url of 16 and 32 bytes', () => {
    expect(ID).toHaveLength(22);
    expect(KEY).toHaveLength(43);
    expect(RelayDocId.parse(ID)).toBe(ID);
    expect(RelayKey.parse(KEY)).toBe(KEY);
    // Every byte value at the end encodes canonically.
    for (let last = 0; last < 256; last++) {
      expect(RelayDocId.safeParse(b64u([...new Array<number>(15).fill(0), last])).success).toBe(true);
      expect(RelayKey.safeParse(b64u([...new Array<number>(31).fill(0), last])).success).toBe(true);
    }
  });

  it.each([
    ['too short', KEY.slice(1)],
    ['too long', `${KEY}A`],
    ['padded', `${KEY}=`],
    ['standard alphabet', `${KEY.slice(0, 42)}+`],
    ['non-canonical last character', `${KEY.slice(0, 42)}B`],
    ['whitespace', ` ${KEY.slice(1)}`],
  ])('reject a key that is %s', (_name, value) => {
    expect(RelayKey.safeParse(value).success).toBe(false);
  });

  it('reject an id that is not canonical or has the wrong length', () => {
    expect(RelayDocId.safeParse(`${ID.slice(0, 21)}B`).success).toBe(false);
    expect(RelayDocId.safeParse(ID.slice(1)).success).toBe(false);
    expect(RelayDocId.safeParse(KEY).success).toBe(false);
    expect(RelayKey.safeParse(ID).success).toBe(false);
  });
});

describe('relay bodies', () => {
  it('parse the documented shapes', () => {
    expect(LoginBody.parse({ email: 'A@B.example', turnstile: 'tok' })).toEqual({
      email: 'a@b.example',
      turnstile: 'tok',
    });
    expect(VerifyBody.parse({ email: 'a@b.example', code: '012345' }).code).toBe('012345');
    expect(SendBody.parse({ key: KEY })).toEqual({ key: KEY });
    expect(OkResponse.parse({ ok: true })).toEqual({ ok: true });
    const expiresAt = '2026-10-14T12:00:00.000Z';
    expect(SessionResponse.parse({ session: 's.t', expiresAt })).toEqual({ session: 's.t', expiresAt });
    expect(CreateDocResponse.parse({ id: ID, expiresAt })).toEqual({ id: ID, expiresAt });
    expect(RelayError.parse({ error: 'Wrong code.', code: 'bad-code' }).code).toBe('bad-code');
  });

  it.each(['12345', '1234567', '12a456', ' 123456', '１２３４５６'])('reject the code %j', (code) => {
    expect(VerifyBody.safeParse({ email: 'a@b.example', code }).success).toBe(false);
  });

  it('reject unknown keys', () => {
    expect(LoginBody.safeParse({ email: 'a@b.example', turnstile: 't', extra: 1 }).success).toBe(false);
    expect(SendBody.safeParse({ key: KEY, id: ID }).success).toBe(false);
    expect(OkResponse.safeParse({ ok: true, more: 1 }).success).toBe(false);
  });

  it('reject an empty Turnstile token, ok:false and a bad expiry', () => {
    expect(LoginBody.safeParse({ email: 'a@b.example', turnstile: '' }).success).toBe(false);
    expect(OkResponse.safeParse({ ok: false }).success).toBe(false);
    expect(CreateDocResponse.safeParse({ id: ID, expiresAt: 'tomorrow' }).success).toBe(false);
  });
});

describe('passphrase and wrapped key', () => {
  const WRAPPED = b64u(Array.from({ length: 60 }, (_, i) => i * 3));

  it('needs at least RELAY_PASSPHRASE_MIN characters, counted as code points', () => {
    expect(RELAY_PASSPHRASE_MIN).toBe(8);
    expect(RelayPassphrase.safeParse('1234567').success).toBe(false);
    expect(RelayPassphrase.safeParse('12345678').success).toBe(true);
    // Four emoji are eight UTF-16 units but four characters.
    expect(RelayPassphrase.safeParse('😀😀😀😀').success).toBe(false);
    expect(RelayPassphrase.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('accepts a wrapped key of exactly 80 base64url characters', () => {
    expect(WRAPPED).toHaveLength(80);
    expect(RelayWrappedKey.safeParse(WRAPPED).success).toBe(true);
    expect(SendBody.parse({ key: KEY, wrappedKey: WRAPPED })).toEqual({ key: KEY, wrappedKey: WRAPPED });
  });

  it.each([['short', 79], ['long', 81]])('refuses a %s wrapped key', (_name, length) => {
    expect(RelayWrappedKey.safeParse('A'.repeat(length)).success).toBe(false);
  });

  it('refuses a wrapped key outside base64url', () => {
    expect(RelayWrappedKey.safeParse(`${'A'.repeat(79)}=`).success).toBe(false);
    expect(SendBody.safeParse({ key: KEY, wrappedKey: '' }).success).toBe(false);
  });
});
