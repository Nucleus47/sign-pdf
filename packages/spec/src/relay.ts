/**
 * The relay API: an optional, self-hostable server that passes an encrypted
 * hand-off packet from one signer to the next by email (issue #65). These are
 * the request and response bodies of `/relay/*` and the limits both sides
 * enforce. They are not part of the sign request, so the sign request's JSON
 * Schema does not include them.
 *
 * The server stores ciphertext only. The key travels in the link's fragment
 * (`#relay=<id>&k=<key>`), which browsers never send to a server.
 */
// First: configures zod before any schema is built (see the file).
import './zod-config.ts';
import { z } from 'zod';

/** Largest encrypted blob the relay accepts: 40 MiB. */
export const RELAY_MAX_BLOB_BYTES = 40 * 2 ** 20;
/** Every blob is deleted this many days after the first signer's upload. */
export const RELAY_TTL_DAYS = 7;
/** The final signed PDF is deleted this many days after the first signer is emailed. */
export const RELAY_FINAL_TTL_DAYS = 5;
/** Path prefix of every relay route, on the app's own origin. */
export const RELAY_PATH_PREFIX = '/relay';

/** An email address, trimmed and lower-cased before it is checked. */
export const Email = z.string().trim().toLowerCase().max(254).email();
export type Email = z.infer<typeof Email>;

/**
 * Relay ids and keys are unpadded base64url (RFC 4648 §5) in canonical form:
 * the unused low bits of the last character must be zero, so each value has
 * exactly one spelling.
 */

/** A relay document id: 128 random bits as 22 base64url characters (last one A, Q, g or w). */
export const RelayDocId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{21}[AQgw]$/, 'must be a relay document id: 22 base64url characters');
export type RelayDocId = z.infer<typeof RelayDocId>;

/**
 * A relay document key: 256 random bits as 43 base64url characters (the last
 * one's two low bits zero). It belongs only in a link fragment and in `/send`.
 */
export const RelayKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, 'must be a relay key: 43 base64url characters');
export type RelayKey = z.infer<typeof RelayKey>;

/** `POST /relay/login`: asks for a sign-in code by email. */
export const LoginBody = z.strictObject({
  email: Email,
  /** Turnstile response token, checked by the server. */
  turnstile: z.string().min(1).max(4096),
});
export type LoginBody = z.infer<typeof LoginBody>;

/** `POST /relay/login/verify`: the six-digit code from the email. */
export const VerifyBody = z.strictObject({
  email: Email,
  code: z.string().regex(/^\d{6}$/, 'must be six digits'),
});
export type VerifyBody = z.infer<typeof VerifyBody>;

/** Answer to `POST /relay/login/verify`. */
export const SessionResponse = z.strictObject({
  /** Bearer token for the upload and send routes. */
  session: z.string().min(1).max(1024),
  expiresAt: z.iso.datetime(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Answer to `GET /relay/config`: what the browser needs before signing in. */
export const RelayConfigResponse = z.strictObject({
  /** The Turnstile site key; empty when the relay does not check Turnstile (local runs). */
  turnstileSiteKey: z.string().max(256),
});
export type RelayConfigResponse = z.infer<typeof RelayConfigResponse>;

/** Answer to `PUT /relay/docs/:id`. The id is the one the browser chose. */
export const CreateDocResponse = z.strictObject({
  id: RelayDocId,
  expiresAt: z.iso.datetime(),
});
export type CreateDocResponse = z.infer<typeof CreateDocResponse>;

/**
 * The shortest passphrase the first signer can set (Unicode code points after
 * NFC). Only the browser can check it: the relay never receives the
 * passphrase, only whether one was set and the key wrapped with it.
 */
export const RELAY_PASSPHRASE_MIN = 8;
/** The longest passphrase the form accepts. */
export const RELAY_PASSPHRASE_MAX = 200;

/** A passphrase the first signer sets: RELAY_PASSPHRASE_MIN to RELAY_PASSPHRASE_MAX characters. */
export const RelayPassphrase = z
  .string()
  .refine((value) => [...value.normalize('NFC')].length >= RELAY_PASSPHRASE_MIN, {
    message: `must have at least ${RELAY_PASSPHRASE_MIN} characters`,
  })
  .refine((value) => [...value.normalize('NFC')].length <= RELAY_PASSPHRASE_MAX, {
    message: `must have at most ${RELAY_PASSPHRASE_MAX} characters`,
  });

/**
 * The document key wrapped with a key from the passphrase (issue #105): a
 * 12-byte nonce, then the AES-GCM ciphertext of the 32-byte key and its
 * 16-byte tag. 60 bytes as exactly 80 base64url characters. The relay stores
 * it and hands it back with the signed PDF, so the first signer can collect
 * on any device. It cannot open without the passphrase.
 */
export const RelayWrappedKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{80}$/, 'must be a wrapped relay key: 80 base64url characters');
export type RelayWrappedKey = z.infer<typeof RelayWrappedKey>;

/**
 * `POST /relay/docs/:id/send`: the key for the next signer's link, and the
 * wrapped key. The wrapped key is required when the upload set the password
 * flag, and refused when it did not.
 */
export const SendBody = z.strictObject({ key: RelayKey, wrappedKey: RelayWrappedKey.optional() });
export type SendBody = z.infer<typeof SendBody>;

/** Success with nothing else to say. */
export const OkResponse = z.strictObject({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** Every relay error: the same shape as the loopback `/api` errors. */
export const RelayError = z.strictObject({
  /** A sentence for the human. */
  error: z.string().min(1).max(1000),
  /** A stable code for programs, such as `bad-code`. */
  code: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'must be a lower-case code'),
});
export type RelayError = z.infer<typeof RelayError>;
