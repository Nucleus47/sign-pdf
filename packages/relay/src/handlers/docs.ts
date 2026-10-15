/**
 * `PUT /relay/docs/:id`, `GET /relay/docs/:id` and `DELETE /relay/docs/:id`: the
 * encrypted hand-off packet. The server never sees its key or its content.
 */
import { Email, RELAY_TTL_DAYS } from '@sign-pdf/spec';
import { declaredLength, putStream } from '../blob.ts';
import { now } from '../clock.ts';
import { sha256Hex } from '../crypto.ts';
import type { Env } from '../env.ts';
import { HttpError, NO_STORE_HEADERS, badRequest, json, notFound, rateLimited, unauthorized } from '../http.ts';
import { allowedForEmail, allowedForIp } from '../ratelimit.ts';
import { readSession } from '../session.ts';
import { CREATE_ONLY, deleteDoc, getHandoff, handoffMetadata, keys } from '../storage.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const idTaken = (): HttpError => new HttpError(409, 'id-taken', 'This document id is in use. Try again.');

/**
 * The browser picks the id (128 random bits), because the encryption binds the
 * blob to its id before the upload (AAD and password salt, docs/relay.md).
 * The write is create-only, and an id that still has any object is refused,
 * so an upload never replaces or revives another document.
 */
export async function upload(id: string, request: Request, env: Env): Promise<Response> {
  const from = await readSession(env, request);
  if (!from) throw unauthorized();
  if (!(await allowedForIp(env.RL_UPLOAD, request))) throw rateLimited();
  if (!(await allowedForEmail(env.RL_UPLOAD, await sha256Hex(from)))) throw rateLimited();

  const to = Email.safeParse(request.headers.get('X-Relay-To') ?? '');
  if (!to.success) throw badRequest('X-Relay-To must be an email address.');
  const password = request.headers.get('X-Relay-Password');
  if (password !== '0' && password !== '1') throw badRequest('X-Relay-Password must be 0 or 1.');
  const length = declaredLength(request);

  const leftovers = await Promise.all([
    env.BLOBS.head(keys.sent(id)),
    env.BLOBS.head(keys.final(id)),
    env.BLOBS.head(keys.finalGate(id)),
  ]);
  if (leftovers.some((object) => object !== null)) throw idTaken();
  const expiresAt = now() + RELAY_TTL_DAYS * DAY_MS;
  const written = await putStream(env.BLOBS, keys.handoff(id), request, length, {
    onlyIf: CREATE_ONLY,
    customMetadata: handoffMetadata({ from, to: to.data, password: password === '1', expiresAt }),
  });
  if (!written) throw idTaken();
  return json({ id, expiresAt: new Date(expiresAt).toISOString() });
}

/** The id is the capability: anyone with it can read the ciphertext. */
export async function getDoc(id: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await allowedForIp(env.RL_READ, request))) throw rateLimited();
  const handoff = await getHandoff(env.BLOBS, id, (p) => ctx.waitUntil(p));
  if (!handoff) throw notFound();
  return new Response(handoff.body, {
    headers: {
      ...NO_STORE_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(handoff.size),
      'X-Relay-Password': handoff.meta.password ? '1' : '0',
    },
  });
}

/** 204 always: deleting is denial at worst, never disclosure. */
export async function deleteDocRoute(id: string | null, request: Request, env: Env): Promise<Response> {
  if (!(await allowedForIp(env.RL_READ, request))) throw rateLimited();
  if (id) await deleteDoc(env.BLOBS, id);
  return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
}
