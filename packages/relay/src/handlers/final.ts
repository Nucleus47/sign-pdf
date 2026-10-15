/**
 * `PUT /relay/docs/:id/final` and `GET /relay/docs/:id/final`: the next signer
 * uploads the encrypted signed PDF once; the first signer collects it with the
 * emailed six-digit code. With the right code, the answer also carries the
 * wrapped key in `X-Relay-Wrapped-Key` when the sender set a passphrase
 * (issue #105). The wrapped key is never logged.
 */
import { RELAY_FINAL_TTL_DAYS, RelayWrappedKey } from '@sign-pdf/spec';
import { declaredLength, putStream } from '../blob.ts';
import { now } from '../clock.ts';
import { codeHash, codeMatches, sixDigitCode } from '../crypto.ts';
import type { Env } from '../env.ts';
import { HttpError, NO_STORE_HEADERS, json, notFound, rateLimited } from '../http.ts';
import { logMailFailure, mailTransport } from '../mail/transport.ts';
import { signedMessage } from '../mail/templates.ts';
import { allowedForIp } from '../ratelimit.ts';
import { relaySecret } from '../session.ts';
import {
  CREATE_ONLY,
  type FinalGate,
  deleteDoc,
  headHandoff,
  keys,
  readFinalGate,
  readSentWrappedKey,
  reserveAttempt,
} from '../storage.ts';
import { MAX_CODE_ATTEMPTS } from './login.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const finalScope = (id: string) => `final:${id}`;
const finalExists = (): HttpError => new HttpError(409, 'final-exists', 'This document was already signed.');
const badCode = (): HttpError => new HttpError(401, 'bad-code', 'The code is wrong.');

export async function putFinal(id: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await allowedForIp(env.RL_UPLOAD, request))) throw rateLimited();
  const secret = relaySecret(env);
  const transport = mailTransport(env);
  const background = (p: Promise<unknown>) => ctx.waitUntil(p);

  // Fail fast before reading up to 40 MiB.
  if (await env.BLOBS.head(keys.final(id))) throw finalExists();
  const handoff = await headHandoff(env.BLOBS, id, background);
  if (!handoff) throw notFound();
  const length = declaredLength(request);

  const expiresAt = Math.min(handoff.expiresAt, now() + RELAY_FINAL_TTL_DAYS * DAY_MS);
  const written = await putStream(env.BLOBS, keys.final(id), request, length, {
    onlyIf: CREATE_ONLY,
    customMetadata: { expiresAt: String(expiresAt) },
  });
  if (!written) throw finalExists();

  const code = sixDigitCode();
  const wrappedKey = handoff.password ? await readSentWrappedKey(env.BLOBS, id) : undefined;
  const gate: FinalGate = {
    to: handoff.from,
    codeHash: await codeHash(secret, finalScope(id), code),
    attempts: 0,
    expiresAt,
    ...(wrappedKey ? { wrappedKey } : {}),
  };
  await env.BLOBS.put(keys.finalGate(id), JSON.stringify(gate));

  try {
    await transport.send(
      signedMessage({
        to: handoff.from,
        signer: handoff.to,
        link: `${env.PUBLIC_ORIGIN}/#relay=${id}`,
        code,
        deletesAt: expiresAt,
        passphrase: wrappedKey !== undefined,
      }),
    );
  } catch (error) {
    // Undo the upload so the signer can try again; the hand-off is still there.
    logMailFailure('final', error);
    await env.BLOBS.delete([keys.final(id), keys.finalGate(id)]);
    throw new HttpError(502, 'email-failed', 'The email could not be sent. Try again.');
  }
  await env.BLOBS.delete([keys.handoff(id), keys.sent(id)]);
  return json({ ok: true });
}

export async function getFinal(id: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await allowedForIp(env.RL_READ, request))) throw rateLimited();
  const secret = relaySecret(env);
  const gate = await readFinalGate(env.BLOBS, id, (p) => ctx.waitUntil(p));
  if (!gate) throw notFound();
  const code = request.headers.get('X-Relay-Code') ?? '';
  if (!/^\d{6}$/.test(code)) throw badCode();
  if (gate.value.attempts >= MAX_CODE_ATTEMPTS) {
    await deleteDoc(env.BLOBS, id);
    throw notFound();
  }
  const attempts = await reserveAttempt(env.BLOBS, keys.finalGate(id), gate);
  if (attempts === null) throw badCode();
  if (!(await codeMatches(secret, finalScope(id), code, gate.value.codeHash))) {
    if (attempts >= MAX_CODE_ATTEMPTS) await deleteDoc(env.BLOBS, id);
    throw badCode();
  }
  const object = await env.BLOBS.get(keys.final(id));
  if (!object) throw notFound();
  const wrapped = RelayWrappedKey.safeParse(gate.value.wrappedKey);
  return new Response(object.body, {
    headers: {
      ...NO_STORE_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      ...(wrapped.success ? { 'X-Relay-Wrapped-Key': wrapped.data } : {}),
    },
  });
}
