/**
 * `POST /relay/login` and `POST /relay/login/verify`: the first signer proves
 * they read their own inbox with a six-digit code, and gets a 24-hour session.
 */
import { LoginBody, VerifyBody } from '@sign-pdf/spec';
import { now } from '../clock.ts';
import { codeHash, codeMatches, sha256Hex, sixDigitCode } from '../crypto.ts';
import type { Env } from '../env.ts';
import { HttpError, badRequest, clientIp, json, rateLimited, readJson } from '../http.ts';
import { logMailFailure, mailTransport } from '../mail/transport.ts';
import { loginCodeMessage } from '../mail/templates.ts';
import {
  LOGIN_CODES_PER_ADDRESS_PER_DAY,
  LOGIN_EMAILS_PER_DAY,
  countUnderCap,
  quotaKeys,
  utcDay,
} from '../quota.ts';
import { allowedForEmail, allowedForIp } from '../ratelimit.ts';
import { issueSession, relaySecret } from '../session.ts';
import { keys, readLoginGate, reserveAttempt } from '../storage.ts';
import { turnstileOk } from '../turnstile.ts';

export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

const loginScope = (emailHash: string) => `login:${emailHash}`;

/**
 * Always `{ok: true}` once the body is valid: also when Turnstile fails, a
 * rate limit or a daily cap hits, or the mail fails. The mail goes out after the response,
 * so the response time does not show which case happened either.
 */
export async function login(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = LoginBody.safeParse(await readJson(request));
  if (!body.success) throw badRequest();
  const secret = relaySecret(env);
  const transport = mailTransport(env);
  const { email, turnstile } = body.data;
  const emailHash = await sha256Hex(email);

  ctx.waitUntil(
    (async () => {
      if (!(await allowedForIp(env.RL_LOGIN_IP, request))) return;
      if (!(await allowedForEmail(env.RL_LOGIN_EMAIL, emailHash))) return;
      if (!(await turnstileOk(env, turnstile, clientIp(request)))) return;
      // A new code keeps the failed-attempt count of the live one, so asking for
      // codes again never buys more guesses. A locked email waits for expiry.
      const live = await readLoginGate(env.BLOBS, emailHash, (p) => ctx.waitUntil(p));
      if (live && live.value.attempts >= MAX_CODE_ATTEMPTS) return;
      // The daily caps come before the new code replaces the live one, so a
      // capped request leaves the code already sent working.
      const day = utcDay();
      const perAddress = quotaKeys.loginAddress(day, emailHash);
      if (!(await underCap(env.BLOBS, 'address', perAddress, LOGIN_CODES_PER_ADDRESS_PER_DAY))) return;
      if (!(await underCap(env.BLOBS, 'global', quotaKeys.loginGlobal(day), LOGIN_EMAILS_PER_DAY))) return;
      const code = sixDigitCode();
      const gate = {
        codeHash: await codeHash(secret, loginScope(emailHash), code),
        attempts: live?.value.attempts ?? 0,
        expiresAt: now() + LOGIN_CODE_TTL_MS,
      };
      // Compare-and-swap on the live record; with none (or only an expired one), overwrite.
      const written = await env.BLOBS.put(
        keys.login(emailHash),
        JSON.stringify(gate),
        live ? { onlyIf: { etagMatches: live.etag } } : {},
      );
      if (!written) return;
      try {
        await transport.send(loginCodeMessage(email, code));
      } catch (error) {
        logMailFailure('login', error);
      }
    })().catch(() => console.error('relay: login background-failed')),
  );
  return json({ ok: true });
}

/** Counts one login email against a daily cap. Logs the cap's name only, never the address. */
async function underCap(bucket: R2Bucket, name: 'address' | 'global', key: string, cap: number): Promise<boolean> {
  const result = await countUnderCap(bucket, key, cap);
  if (result === 'capped') console.error(`relay: login cap-${name}`);
  if (result === 'failed') console.error(`relay: login cap-${name}-unavailable`);
  return result === 'counted';
}

/** A well-formed hash that no code matches; used only to pad the timing of a miss. */
const TIMING_PAD_HASH = 'A'.repeat(43);

const badCode = (): HttpError => new HttpError(401, 'bad-code', 'The code is wrong or has expired.');

/**
 * The same 401 for a wrong, expired, used or locked code. Five wrong attempts
 * lock the email until the code expires (10 minutes after the last code).
 */
export async function verify(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = VerifyBody.safeParse(await readJson(request));
  if (!body.success) throw badRequest();
  const secret = relaySecret(env);
  const { email, code } = body.data;
  const emailHash = await sha256Hex(email);
  if (!(await allowedForIp(env.RL_VERIFY, request))) throw rateLimited();
  if (!(await allowedForEmail(env.RL_VERIFY, emailHash))) throw rateLimited();

  const key = keys.login(emailHash);
  const gate = await readLoginGate(env.BLOBS, emailHash, (p) => ctx.waitUntil(p));
  if (!gate) {
    // The same work as a wrong guess, so the response time does not show whether a code is open.
    await env.BLOBS.put(keys.login('timing-pad'), '', { onlyIf: { etagMatches: 'none' } });
    await codeMatches(secret, loginScope(emailHash), code, TIMING_PAD_HASH);
    throw badCode();
  }
  // A locked record stays until it expires, so a new code cannot reset the count.
  if (gate.value.attempts >= MAX_CODE_ATTEMPTS) throw badCode();
  const attempts = await reserveAttempt(env.BLOBS, key, gate);
  if (attempts === null) throw badCode();
  if (!(await codeMatches(secret, loginScope(emailHash), code, gate.value.codeHash))) throw badCode();
  await env.BLOBS.delete(key);
  const session = await issueSession(env, email);
  return json({ session: session.session, expiresAt: new Date(session.expiresAt).toISOString() });
}
