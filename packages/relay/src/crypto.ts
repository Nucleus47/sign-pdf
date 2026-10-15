/** Small WebCrypto helpers: base64url, SHA-256, HMAC and random values. */

const encoder = new TextEncoder();

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns null for anything that is not unpadded base64url. */
export function base64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function hmac(secret: string, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message)));
}

/** Constant-time check of an HMAC-SHA256 signature. */
export async function hmacVerify(secret: string, message: string, signature: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify('HMAC', await hmacKey(secret), signature, encoder.encode(message));
}

/**
 * The stored form of a one-time code: HMAC(secret, scope|code), base64url.
 * The scope binds the code to one email or one document.
 */
export async function codeHash(secret: string, scope: string, code: string): Promise<string> {
  return base64urlEncode(await hmac(secret, `${scope}|${code}`));
}

/** Constant-time comparison of a candidate code against its stored hash. */
export async function codeMatches(secret: string, scope: string, code: string, stored: string): Promise<boolean> {
  const expected = base64urlDecode(stored);
  if (!expected) return false;
  return hmacVerify(secret, `${scope}|${code}`, expected);
}

/** A uniformly random six-digit code. */
export function sixDigitCode(): string {
  const buffer = new Uint32Array(1);
  // Rejection sampling: 4 294 000 000 is the largest multiple of 10^6 below 2^32.
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0]!;
    if (value < 4_294_000_000) return String(value % 1_000_000).padStart(6, '0');
  }
}

/** A relay document id: 128 random bits, base64url (22 characters). */
export function newDocId(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}
