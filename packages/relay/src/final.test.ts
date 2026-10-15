import { afterEach, describe, expect, it, vi } from 'vitest';
import { setClockOffsetForTests } from './clock.ts';
import { putStream } from './blob.ts';
import { CREATE_ONLY, keys } from './storage.ts';
import { TEST_WRAPPED_KEY, blob, call, env, finalCode, freshIp, lastMailTo, putFinal, sentDoc } from './testing.ts';

afterEach(() => {
  setClockOffsetForTests(0);
  vi.restoreAllMocks();
});

const DAY = 24 * 60 * 60 * 1000;

const getFinal = (id: string, code?: string, ip?: string) =>
  call('GET', `/relay/docs/${id}/final`, {
    ...(code === undefined ? {} : { headers: { 'X-Relay-Code': code } }),
    ...(ip ? { ip } : {}),
  });

const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('R2 create-only writes in the emulator', () => {
  it('etagDoesNotMatch "*" writes a new key and refuses an existing one', async () => {
    expect(await env.BLOBS.put('probe/new', 'one', { onlyIf: CREATE_ONLY })).not.toBeNull();
    expect(await env.BLOBS.put('probe/new', 'two', { onlyIf: CREATE_ONLY })).toBeNull();
    expect(await (await env.BLOBS.get('probe/new'))!.text()).toBe('one');
  });

  // workerd prints two 'client disconnected' uncaught errors for this test: R2 refuses the
  // put without reading the stream. The handler code catches both of its pipes.
  it('a failed parallel upload never deletes the object that won', async () => {
    await env.BLOBS.put('probe/won', 'legit');
    const lying = new Request('https://sign.example/', {
      method: 'PUT',
      headers: { 'Content-Length': '4' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }),
    });
    await putStream(env.BLOBS, 'probe/won', lying, 4, { onlyIf: CREATE_ONLY }).catch(() => null);
    expect(await (await env.BLOBS.get('probe/won'))!.text()).toBe('legit');
  });
});

describe('PUT /relay/docs/:id/final', () => {
  it('stores the final once, deletes the hand-off and emails the sender a link and code', async () => {
    const { a, b, id } = await sentDoc();
    const response = await putFinal(id);
    expect(response.status).toBe(200);
    expect(await env.BLOBS.head(keys.handoff(id))).toBeNull();
    expect((await call('GET', `/relay/docs/${id}`)).status).toBe(404);

    const mail = await lastMailTo(a);
    expect(mail?.subject).toBe('Your document has been signed');
    expect(mail?.replyTo).toBe(b);
    expect(mail?.text).toContain(`Open it on the device you sent it from: ${env.PUBLIC_ORIGIN}/#relay=${id}\n`);
    expect(mail?.text).not.toContain('&k=');
    expect(mail?.text).toMatch(/Your code: \d{6}/);
    expect(mail?.text).toMatch(/deleted on \d{1,2} \w+ \d{4} \(UTC\)/);

    const again = await putFinal(id, blob(32, 1));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('final-exists');
  });

  it('expires 5 days after the email, or with the hand-off if that is sooner', async () => {
    const { id } = await sentDoc();
    await putFinal(id);
    const gate = (await (await env.BLOBS.get(keys.finalGate(id)))!.json()) as { expiresAt: number };
    expect(gate.expiresAt - Date.now()).toBeGreaterThan(5 * DAY - 60_000);
    expect(gate.expiresAt - Date.now()).toBeLessThanOrEqual(5 * DAY);

    // Signed on day 6: the hand-off's day-7 expiry wins over day 6 + 5.
    const late = await sentDoc();
    setClockOffsetForTests(6 * DAY);
    await putFinal(late.id);
    const lateGate = (await (await env.BLOBS.get(keys.finalGate(late.id)))!.json()) as { expiresAt: number };
    expect(Math.abs(lateGate.expiresAt - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
  });

  it('answers 404 when there is no hand-off', async () => {
    expect((await putFinal('AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
  });

  it('keeps the hand-off and stores nothing when the mail fails', async () => {
    const { id } = await sentDoc();
    const failing = {
      ...env,
      MAIL_TRANSPORT: 'cloudflare',
      EMAIL: {
        send: async () => {
          throw Object.assign(new Error('x'), { code: 'E_DELIVERY_FAILED' });
        },
      },
    } as unknown as typeof env;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bytes = blob(16);
    const response = await call('PUT', `/relay/docs/${id}/final`, {
      headers: { 'Content-Length': '16' },
      body: bytes,
      env: failing,
    });
    expect(response.status).toBe(502);
    expect(log).toHaveBeenCalledWith('relay: final email-failed E_DELIVERY_FAILED');
    expect(await env.BLOBS.head(keys.final(id))).toBeNull();
    expect(await env.BLOBS.head(keys.handoff(id))).not.toBeNull();
    expect((await putFinal(id)).status).toBe(200);
  });
});

describe('GET /relay/docs/:id/final', () => {
  it('returns the final for the right code', async () => {
    const { a, id } = await sentDoc();
    const bytes = blob(48, 4);
    await putFinal(id, bytes);
    const response = await getFinal(id, await finalCode(a));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('returns the wrapped key in X-Relay-Wrapped-Key only with the right code', async () => {
    const { a, id } = await sentDoc('1');
    const bytes = blob(48, 5);
    await putFinal(id, bytes);
    const code = await finalCode(a);
    const gate = (await (await env.BLOBS.get(keys.finalGate(id)))!.json()) as { wrappedKey?: string };
    expect(gate.wrappedKey).toBe(TEST_WRAPPED_KEY);
    // The email says the link opens on any device, and never holds the wrapped key.
    const mail = await lastMailTo(a);
    expect(mail?.text).toContain(`Open it on any device: ${env.PUBLIC_ORIGIN}/#relay=${id}\n`);
    expect(mail?.text).toContain('you also need the passphrase you set');
    expect(mail?.text).not.toContain(TEST_WRAPPED_KEY);

    const refused = await getFinal(id, wrong(code));
    expect(refused.status).toBe(401);
    expect(refused.headers.get('X-Relay-Wrapped-Key')).toBeNull();
    expect(await refused.text()).not.toContain(TEST_WRAPPED_KEY);

    // The attempt count rewrote the gate; the wrapped key is still there.
    const response = await getFinal(id, code);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Relay-Wrapped-Key')).toBe(TEST_WRAPPED_KEY);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('sends no X-Relay-Wrapped-Key when the sender set no passphrase', async () => {
    const { a, id } = await sentDoc();
    await putFinal(id);
    const gate = (await (await env.BLOBS.get(keys.finalGate(id)))!.json()) as Record<string, unknown>;
    expect(gate).not.toHaveProperty('wrappedKey');
    const response = await getFinal(id, await finalCode(a));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Relay-Wrapped-Key')).toBeNull();
  });

  it('keeps a wrapped key that arrived with a still-pending send claim', async () => {
    // The next signer can sign before the send marks itself sent.
    const { a, id } = await sentDoc('1');
    await env.BLOBS.put(keys.sent(id), JSON.stringify({ state: 'pending', at: Date.now(), wrappedKey: TEST_WRAPPED_KEY }));
    await putFinal(id);
    const response = await getFinal(id, await finalCode(a));
    expect(response.headers.get('X-Relay-Wrapped-Key')).toBe(TEST_WRAPPED_KEY);
  });

  it('deletes the wrapped key with the document', async () => {
    const { a, id } = await sentDoc('1');
    await putFinal(id);
    const code = await finalCode(a);
    expect((await call('DELETE', `/relay/docs/${id}`)).status).toBe(204);
    expect(await env.BLOBS.head(keys.finalGate(id))).toBeNull();
    expect(await env.BLOBS.head(keys.sent(id))).toBeNull();
    expect((await getFinal(id, code)).status).toBe(404);
  });

  it('refuses a missing or wrong code and deletes everything after five attempts', async () => {
    const { a, id } = await sentDoc();
    await putFinal(id);
    const code = await finalCode(a);
    expect((await getFinal(id)).status).toBe(401);
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      const response = await getFinal(id, wrong(code), ip);
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe('bad-code');
    }
    expect((await getFinal(id, code)).status).toBe(404);
    expect(await env.BLOBS.head(keys.final(id))).toBeNull();
    expect(await env.BLOBS.head(keys.finalGate(id))).toBeNull();
  });

  it('answers 404 after expiry and deletes the final', async () => {
    const { a, id } = await sentDoc();
    await putFinal(id);
    const code = await finalCode(a);
    setClockOffsetForTests(5 * DAY + 1);
    expect((await getFinal(id, code)).status).toBe(404);
    setClockOffsetForTests(0);
    expect(await env.BLOBS.head(keys.final(id))).toBeNull();
  });

  it('is gone after DELETE', async () => {
    const { a, id } = await sentDoc();
    await putFinal(id);
    const code = await finalCode(a);
    expect((await call('DELETE', `/relay/docs/${id}`)).status).toBe(204);
    expect((await getFinal(id, code)).status).toBe(404);
  });
});
