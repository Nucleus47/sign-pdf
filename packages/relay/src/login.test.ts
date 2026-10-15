import { afterEach, describe, expect, it, vi } from 'vitest';
import { setClockOffsetForTests } from './clock.ts';
import { newDocId, sha256Hex } from './crypto.ts';
import { keys } from './storage.ts';
import { call, env, freshEmail, freshIp, lastMailTo, loginCode, outbox, signIn, uploadDoc } from './testing.ts';

afterEach(() => {
  setClockOffsetForTests(0);
  vi.restoreAllMocks();
});

const verify = (email: string, code: string, ip?: string) =>
  call('POST', '/relay/login/verify', { json: { email, code }, ...(ip ? { ip } : {}) });

function wrongCode(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
}

describe('login', () => {
  it('emails a code that verifies once and gives a 24-hour session', async () => {
    const email = freshEmail();
    const code = await loginCode(email);
    const mail = await lastMailTo(email);
    expect(mail?.from).toBe(env.MAIL_FROM);
    expect(mail?.subject).toContain(code);

    const response = await verify(email, code);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: string; expiresAt: string };
    const hours = (Date.parse(body.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    // Single use: the same code is now refused.
    expect((await verify(email, code)).status).toBe(401);
  });

  it('normalizes the address before it checks the code', async () => {
    const email = freshEmail();
    const code = await loginCode(`  ${email.toUpperCase()} `, email);
    expect((await verify(email, code)).status).toBe(200);
  });

  it('locks the code after five wrong attempts', async () => {
    const email = freshEmail();
    const code = await loginCode(email);
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      const response = await verify(email, wrongCode(code), ip);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String), code: 'bad-code' });
    }
    // The right code no longer works, and a new code is not sent while the lock lasts.
    expect((await verify(email, code)).status).toBe(401);
    const mails = (await outbox()).filter((m) => m.to === email).length;
    await call('POST', '/relay/login', { json: { email, turnstile: 'x' } });
    expect((await outbox()).filter((m) => m.to === email).length).toBe(mails);

    // After the code expires, a new code works.
    setClockOffsetForTests(10 * 60 * 1000 + 1);
    const fresh = await loginCode(email);
    expect((await verify(email, fresh)).status).toBe(200);
  });

  it('keeps the failed attempts when a new code is asked for', async () => {
    const email = freshEmail();
    const first = await loginCode(email);
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await verify(email, wrongCode(first), ip);
    const second = await loginCode(email);
    // One attempt left: a wrong guess locks it, then the right code fails.
    expect((await verify(email, wrongCode(second), ip)).status).toBe(401);
    expect((await verify(email, second, ip)).status).toBe(401);
  });

  it('refuses an expired code with the same 401 and deletes it', async () => {
    const email = freshEmail();
    const code = await loginCode(email);
    setClockOffsetForTests(10 * 60 * 1000 + 1);
    const expired = await verify(email, code);
    const unknown = await verify(freshEmail(), code);
    expect(expired.status).toBe(401);
    expect(await expired.text()).toBe(await unknown.text());
    expect(await env.BLOBS.head(keys.login(await sha256Hex(email)))).toBeNull();
  });

  it('answers 400 to a malformed body', async () => {
    expect((await call('POST', '/relay/login', { json: { email: 'nope', turnstile: 'x' } })).status).toBe(400);
    expect((await call('POST', '/relay/login', { body: '{', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    expect((await verify(freshEmail(), '12345')).status).toBe(400);
    // A JSON body past 8 KiB is refused while it streams, with or without Content-Length.
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(1024).fill(32));
        controller.close();
      },
    });
    expect((await call('POST', '/relay/login', { body: big })).status).toBe(400);
  });

  it('rate-limits verify per address', async () => {
    const email = freshEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await verify(email, '000000')).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('login enumeration resistance', () => {
  async function loginResponse(email: string, options: Parameters<typeof call>[2] = {}) {
    const response = await call('POST', '/relay/login', { json: { email, turnstile: 'token' }, ...options });
    return { status: response.status, body: await response.text(), type: response.headers.get('Content-Type') };
  }

  it('gives the same answer for a new address, a rate limit, a Turnstile failure and a mail failure', async () => {
    const normal = await loginResponse(freshEmail());

    const limitedEmail = freshEmail();
    for (let i = 0; i < 3; i++) await loginResponse(limitedEmail);
    const before = (await outbox()).filter((m) => m.to === limitedEmail).length;
    const limited = await loginResponse(limitedEmail);
    expect((await outbox()).filter((m) => m.to === limitedEmail).length).toBe(before);

    const failingMail = {
      ...env,
      MAIL_TRANSPORT: 'cloudflare',
      EMAIL: {
        send: async () => {
          throw Object.assign(new Error('suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' });
        },
      },
    } as unknown as typeof env;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mailFailed = await loginResponse(freshEmail(), { env: failingMail });
    expect(errors).toHaveBeenCalledWith('relay: login email-failed E_RECIPIENT_SUPPRESSED');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: false }));
    const turnstileEmail = freshEmail();
    const turnstileFailed = await loginResponse(turnstileEmail, { env: { ...env, TURNSTILE_MODE: 'on' } });
    expect(await lastMailTo(turnstileEmail)).toBeUndefined();

    expect(normal).toEqual({ status: 200, body: '{"ok":true}', type: 'application/json; charset=utf-8' });
    for (const other of [limited, mailFailed, turnstileFailed]) expect(other).toEqual(normal);
  });

  it('sends the code once Turnstile accepts the token', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }));
    const email = freshEmail();
    await loginResponse(email, { env: { ...env, TURNSTILE_MODE: 'on' }, ip: '203.0.113.9' });
    expect(await lastMailTo(email)).toBeDefined();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const form = init?.body as FormData;
    expect(form.get('secret')).toBe(env.TURNSTILE_SECRET);
    expect(form.get('response')).toBe('token');
    expect(form.get('remoteip')).toBe('203.0.113.9');
  });
});

describe('session tokens', () => {
  const put = (authorization: string) =>
    call('PUT', `/relay/docs/${newDocId()}`, {
      headers: { Authorization: authorization, 'X-Relay-To': 'b@example.com', 'X-Relay-Password': '0', 'Content-Length': '4' },
      body: new Uint8Array(4),
    });

  it('refuses a missing, malformed or tampered token', async () => {
    const session = await signIn(freshEmail());
    const [payload, signature] = session.split('.') as [string, string];
    const forged = btoa(JSON.stringify({ e: 'mallory@example.com', exp: Date.now() + 1e7, v: 1 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const flipped = signature.slice(0, -2) + (signature.at(-2) === 'A' ? 'B' : 'A') + signature.at(-1);
    for (const auth of ['', 'Bearer ', `Bearer ${payload}`, `Bearer ${forged}.${signature}`, `Bearer ${payload}.${flipped}`, `Basic ${session}`]) {
      const response = await put(auth);
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe('unauthorized');
    }
    expect((await put(`Bearer ${session}`)).status).toBe(200);
  });

  it('refuses an expired token', async () => {
    const session = await signIn(freshEmail());
    setClockOffsetForTests(24 * 60 * 60 * 1000 + 1);
    expect((await put(`Bearer ${session}`)).status).toBe(401);
  });

  it('uses the address from the session as the sender', async () => {
    const a = freshEmail('a');
    const session = await signIn(a);
    const { id } = await uploadDoc(session, freshEmail('b'));
    const head = await env.BLOBS.head(`relay/${id}/handoff.bin`);
    expect(head?.customMetadata?.from).toBe(a);
  });
});
