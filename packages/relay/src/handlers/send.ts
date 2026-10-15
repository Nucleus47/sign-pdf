/**
 * `POST /relay/docs/:id/send`: emails the next signer the link with the key.
 *
 * The document key passes through this handler. It contains NO logging of any
 * kind, and it never puts the key in an error, a stored object or a response.
 * A test reads this file and fails on any logging call. The same holds for
 * the wrapped key (issue #105): it is stored with the `sent` marker, never logged.
 */
import { SendBody } from '@sign-pdf/spec';
import type { Env } from '../env.ts';
import { HttpError, badRequest, json, notFound, rateLimited, readJson, unauthorized } from '../http.ts';
import { MailError, mailTransport } from '../mail/transport.ts';
import { nextSignerMessage } from '../mail/templates.ts';
import { allowedForIp } from '../ratelimit.ts';
import { readSession } from '../session.ts';
import { claimSend, headHandoff, markSent, releaseSend } from '../storage.ts';

const badWrappedKey = (message: string): HttpError => new HttpError(400, 'bad-wrapped-key', message);

export async function send(id: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const from = await readSession(env, request);
  if (!from) throw unauthorized();
  if (!(await allowedForIp(env.RL_UPLOAD, request))) throw rateLimited();
  const body = SendBody.safeParse(await readJson(request));
  if (!body.success) {
    if (body.error.issues.some((issue) => issue.path[0] === 'wrappedKey')) {
      throw badWrappedKey('wrappedKey must be 80 base64url characters.');
    }
    throw badRequest();
  }
  const wrappedKey = body.data.wrappedKey;
  const transport = mailTransport(env);

  const meta = await headHandoff(env.BLOBS, id, (p) => ctx.waitUntil(p));
  // Only the uploader can send; anyone else sees the same 404 as a missing id.
  if (!meta || meta.from !== from) throw notFound();

  // The server never sees the passphrase, so it checks what it can: a wrapped
  // key comes exactly when the upload said a password was set.
  if (meta.password && !wrappedKey) throw badWrappedKey('A document with a password needs its wrapped key.');
  if (!meta.password && wrappedKey) throw badWrappedKey('A document without a password takes no wrapped key.');

  // One email per document: the claim is create-only.
  const claim = await claimSend(env.BLOBS, id, wrappedKey);
  if (claim === 'sent') throw new HttpError(409, 'already-sent', 'This document was already sent.');
  // Another request is emailing right now; it can still fail, so this is not "sent".
  if (claim === 'pending') throw new HttpError(409, 'send-pending', 'This document is being sent. Try again in a minute.');

  const link = `${env.PUBLIC_ORIGIN}/#relay=${id}&k=${body.data.key}${meta.password ? '&p=1' : ''}`;
  try {
    await transport.send(nextSignerMessage({ from: meta.from, to: meta.to, link, password: meta.password }));
  } catch (error) {
    // Let the sender try again. The error code goes to the client, never to a log.
    await releaseSend(env.BLOBS, id);
    const code = error instanceof MailError ? error.code : 'E_UNKNOWN';
    throw new HttpError(502, 'email-failed', `The email could not be sent (${code}).`);
  }
  await markSent(env.BLOBS, id, wrappedKey);
  return json({ ok: true });
}
