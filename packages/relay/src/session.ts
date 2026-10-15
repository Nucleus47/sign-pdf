/**
 * Stateless session tokens: base64url(payload).base64url(HMAC-SHA256(secret, payload)).
 * The payload is `{e, exp, v: 1}`: the verified email, the expiry in ms since
 * the epoch, and the format version. Nothing is stored server side.
 */
import { Email } from '@sign-pdf/spec';
import { now } from './clock.ts';
import { base64urlDecode, base64urlEncode, hmac, hmacVerify } from './crypto.ts';
import { HttpError } from './http.ts';
import type { Env } from './env.ts';

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 1024;

/** The HMAC secret; a missing or short secret stops every request that needs it. */
export function relaySecret(env: Env): string {
  const secret = env.RELAY_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(500, 'server-error', 'The relay is not configured.');
  }
  return secret;
}

export async function issueSession(env: Env, email: string): Promise<{ session: string; expiresAt: number }> {
  const expiresAt = now() + SESSION_TTL_MS;
  const payload = base64urlEncode(new TextEncoder().encode(JSON.stringify({ e: email, exp: expiresAt, v: 1 })));
  const signature = base64urlEncode(await hmac(relaySecret(env), `session|${payload}`));
  return { session: `${payload}.${signature}`, expiresAt };
}

/** Returns the session's email, or null for a missing, tampered or expired token. */
export async function readSession(env: Env, request: Request): Promise<string | null> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header);
  if (!match || header.length > MAX_TOKEN_LENGTH) return null;
  const [, payload, signature] = match as unknown as [string, string, string];
  const signatureBytes = base64urlDecode(signature);
  if (!signatureBytes) return null;
  if (!(await hmacVerify(relaySecret(env), `session|${payload}`, signatureBytes))) return null;
  const payloadBytes = base64urlDecode(payload);
  if (!payloadBytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { e, exp, v } = parsed as Record<string, unknown>;
  if (v !== 1 || typeof exp !== 'number' || exp <= now()) return null;
  const email = Email.safeParse(e);
  return email.success && email.data === e ? email.data : null;
}
