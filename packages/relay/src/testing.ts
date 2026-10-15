/** Helpers for the Worker tests, which run inside workerd (vitest.config.ts). */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as testEnv } from 'cloudflare:workers';
import { newDocId } from './crypto.ts';
import type { Env } from './env.ts';
import { handleRequest } from './index.ts';
import { listOutbox, type OutboxEntry } from './mail/dev-outbox.ts';

export const env = testEnv as unknown as Env;
export const ORIGIN = 'https://sign.example';

let ipCounter = 0;
/** A fresh client address, so the per-IP limits of one test never touch another. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

let emailCounter = 0;
export function freshEmail(name = 'user'): string {
  emailCounter += 1;
  return `${name}${emailCounter}@example.com`;
}

export interface CallOptions {
  headers?: Record<string, string>;
  body?: BodyInit | null;
  json?: unknown;
  ip?: string;
  env?: Env;
}

/** Runs one request through the Worker and waits for its background work. */
export async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('CF-Connecting-IP', options.ip ?? freshIp());
  let body = options.body ?? null;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers.set('Content-Type', 'application/json');
  }
  const ctx = createExecutionContext();
  const response = await handleRequest(new Request(`${ORIGIN}${path}`, { method, headers, body }), options.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function outbox(): Promise<OutboxEntry[]> {
  return listOutbox(env);
}

export async function lastMailTo(to: string): Promise<OutboxEntry | undefined> {
  return (await outbox()).filter((m) => m.to === to).at(-1);
}

/** Asks for a code as `input` and reads it from the outbox of `mailbox`. */
export async function loginCode(input: string, mailbox = input): Promise<string> {
  const response = await call('POST', '/relay/login', { json: { email: input, turnstile: 'test' } });
  if (response.status !== 200) throw new Error(`login ${response.status}`);
  const mail = await lastMailTo(mailbox);
  const code = /code is (\d{6})/.exec(mail?.text ?? '')?.[1];
  if (!code) throw new Error('no login code in the outbox');
  return code;
}

export async function signIn(email: string): Promise<string> {
  const code = await loginCode(email);
  const response = await call('POST', '/relay/login/verify', { json: { email, code } });
  if (response.status !== 200) throw new Error(`verify ${response.status}`);
  return ((await response.json()) as { session: string }).session;
}

export function blob(size: number, fill = 7): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

export async function uploadDoc(
  session: string,
  to: string,
  bytes: Uint8Array = blob(64),
  password = '0',
  id: string = newDocId(),
): Promise<{ id: string; expiresAt: string }> {
  const response = await call('PUT', `/relay/docs/${id}`, {
    headers: {
      Authorization: `Bearer ${session}`,
      'X-Relay-To': to,
      'X-Relay-Password': password,
      'Content-Length': String(bytes.byteLength),
    },
    body: bytes,
  });
  if (response.status !== 200) throw new Error(`upload ${response.status} ${await response.text()}`);
  return (await response.json()) as { id: string; expiresAt: string };
}

/** A valid 43-character base64url key (fixed, test only). */
export const TEST_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

/** A valid 80-character wrapped key (fixed, test only): what the browser sends when A set a passphrase. */
export const TEST_WRAPPED_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7';

/** Signs A in, uploads a hand-off for B and emails B; with a password, the send carries the wrapped key. */
export async function sentDoc(password = '0') {
  const a = freshEmail('a');
  const b = freshEmail('b');
  const session = await signIn(a);
  const { id } = await uploadDoc(session, b, blob(64), password);
  const response = await call('POST', `/relay/docs/${id}/send`, {
    headers: { Authorization: `Bearer ${session}` },
    json: password === '1' ? { key: TEST_KEY, wrappedKey: TEST_WRAPPED_KEY } : { key: TEST_KEY },
  });
  if (response.status !== 200) throw new Error(`send ${response.status}`);
  return { a, b, session, id };
}

export function putFinal(id: string, bytes: Uint8Array = blob(32, 9)): Promise<Response> {
  return call('PUT', `/relay/docs/${id}/final`, {
    headers: { 'Content-Length': String(bytes.byteLength) },
    body: bytes,
  });
}

export async function finalCode(a: string): Promise<string> {
  const mail = await lastMailTo(a);
  const code = /Your code: (\d{6})/.exec(mail?.text ?? '')?.[1];
  if (!code) throw new Error('no final code in the outbox');
  return code;
}
