/**
 * The sign-pdf Worker. The platform serves static assets (the built web app)
 * without running this script, except for /relay and /relay/*, which run here
 * first: the relay API (docs/relay.md). A hand-rolled router, no framework.
 */
import { RelayDocId, type RelayConfigResponse } from '@sign-pdf/spec';
import type { Env } from './env.ts';
import { deleteDocRoute, getDoc, upload } from './handlers/docs.ts';
import { getFinal, putFinal } from './handlers/final.ts';
import { login, verify } from './handlers/login.ts';
import { send } from './handlers/send.ts';
import { HttpError, json, jsonError, notFound } from './http.ts';
import { listOutbox } from './mail/dev-outbox.ts';

export type { Env } from './env.ts';

function isRelayPath(pathname: string): boolean {
  return pathname === '/relay' || pathname.startsWith('/relay/');
}

/** A valid document id, or null; ids are checked before any R2 key is built. */
function docId(raw: string): string | null {
  return RelayDocId.safeParse(raw).success ? raw : null;
}

/** The prefix of the session secret that `pnpm dev` passes (package.json). */
const DEV_SESSION_SECRET_PREFIX = 'dev-only-';

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * The dev outbox shows every link and key, and the dev session secret is
 * public, so either runs only when the app's origin is a loopback address.
 * Turnstile off is allowed anywhere: the rate limits and daily caps hold.
 */
function assertSafeMode(env: Env): void {
  const devMode =
    env.MAIL_TRANSPORT === 'dev-outbox' || (env.RELAY_SESSION_SECRET ?? '').startsWith(DEV_SESSION_SECRET_PREFIX);
  if (devMode && !LOOPBACK_ORIGIN.test(env.PUBLIC_ORIGIN)) {
    console.error('relay: dev-mode-refused');
    throw new HttpError(500, 'server-error', 'The relay is not configured.');
  }
}

/** What the browser needs before signing in. An empty site key means "no Turnstile widget". */
function relayConfig(env: Env): RelayConfigResponse {
  return { turnstileSiteKey: env.TURNSTILE_MODE === 'off' ? '' : (env.TURNSTILE_SITE_KEY ?? '') };
}

async function route(request: Request, env: Env, ctx: ExecutionContext, pathname: string): Promise<Response> {
  // The feature flag: with the relay off, every relay path is the same 404 an
  // unknown path gets. The web app then hides the email option (it asks
  // /relay/config first), and nothing can upload a blob or send mail.
  if (env.RELAY_MODE !== 'on') throw notFound();
  assertSafeMode(env);
  const method = request.method;
  if (pathname === '/relay/login' && method === 'POST') return login(request, env, ctx);
  if (pathname === '/relay/login/verify' && method === 'POST') return verify(request, env, ctx);
  if (pathname === '/relay/config' && method === 'GET') return json(relayConfig(env));
  if (pathname === '/relay/dev/outbox' && method === 'GET') {
    if (env.MAIL_TRANSPORT !== 'dev-outbox') throw notFound();
    return json({ messages: await listOutbox(env) });
  }

  const match = /^\/relay\/docs\/([^/]+)(\/send|\/final)?$/.exec(pathname);
  if (!match) throw notFound();
  const [, rawId, sub] = match as unknown as [string, string, string | undefined];
  const id = docId(rawId);
  if (!sub && method === 'DELETE') return deleteDocRoute(id, request, env);
  if (!id) throw notFound();
  if (!sub && method === 'PUT') return upload(id, request, env);
  if (!sub && method === 'GET') return getDoc(id, request, env, ctx);
  if (sub === '/send' && method === 'POST') return send(id, request, env, ctx);
  if (sub === '/final' && method === 'PUT') return putFinal(id, request, env, ctx);
  if (sub === '/final' && method === 'GET') return getFinal(id, request, env, ctx);
  throw notFound();
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!isRelayPath(pathname)) return env.ASSETS.fetch(request);
  try {
    return await route(request, env, ctx, pathname);
  } catch (error) {
    if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);
    // Never log the error's message or the request: either can hold a key or
    // a code. The error's name is enough to start looking.
    console.error(`relay: unhandled ${error instanceof Error ? error.name : typeof error}`);
    return jsonError(500, 'server-error', 'Something went wrong. Try again.');
  }
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
