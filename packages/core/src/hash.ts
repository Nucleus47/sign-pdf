/** Hashing and encoding helpers that work in browsers and Node without Buffer. */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Lowercase hex SHA-256 of the given bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer: WebCrypto rejects views over a SharedArrayBuffer,
  // and the copy keeps the digest independent of later changes to `bytes`.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  let out = '';
  for (const byte of new Uint8Array(digest)) out += HEX[byte];
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * JSON with object keys sorted at every level and no whitespace, so that equal
 * values always serialize to the same bytes. `undefined` members are omitted.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Standard-alphabet, padded base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict decode: returns undefined for anything that is not padded standard base64. */
export function base64ToBytes(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return undefined;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
