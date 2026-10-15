import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { newDocId } from './crypto.ts';
import * as entry from './index.ts';
import { handleRequest } from './index.ts';
import { TEST_KEY, blob, call, env, freshEmail, sentDoc } from './testing.ts';

function withFakeAssets() {
  const fetch = vi.fn(async (_request: Request) => new Response('asset', { status: 200 }));
  return { env: { ...env, ASSETS: { fetch } }, fetch };
}

describe('the Worker entry module', () => {
  it('exports only functions and handler objects, which workerd requires to start', () => {
    for (const [name, value] of Object.entries(entry)) {
      expect([name, typeof value]).toSatisfy(([, type]: [string, string]) => type === 'function' || type === 'object');
    }
  });
});

describe('handleRequest', () => {
  it('answers an unknown /relay path with a JSON 404 and never reads assets', async () => {
    const { env: fakeEnv, fetch } = withFakeAssets();
    for (const path of ['/relay', '/relay/x', '/relay/docs/a/b']) {
      const response = await handleRequest(new Request(`https://sign.example${path}`), fakeEnv, createExecutionContext());
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
      expect(await response.json()).toEqual({ error: 'Not found.', code: 'not-found' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes every other path to the assets binding', async () => {
    const { env: fakeEnv, fetch } = withFakeAssets();
    const request = new Request('https://sign.example/relayed/page');
    const response = await handleRequest(request, fakeEnv, createExecutionContext());
    expect(await response.text()).toBe('asset');
    expect(fetch).toHaveBeenCalledWith(request);
  });

  it('refuses every route when the session secret is missing', async () => {
    const response = await call('POST', '/relay/login', {
      json: { email: freshEmail(), turnstile: 'x' },
      env: { ...env, RELAY_SESSION_SECRET: undefined },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'server-error' });
  });
});

describe('dev modes', () => {
  const publicOrigin = { PUBLIC_ORIGIN: 'https://sign.example' };

  it('refuse to run when the origin is not a loopback address', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const modes of [
      { MAIL_TRANSPORT: 'dev-outbox' },
      { MAIL_TRANSPORT: 'cloudflare', RELAY_SESSION_SECRET: 'dev-only-insecure-relay-session-secret' },
    ]) {
      const response = await call('GET', '/relay/dev/outbox', { env: { ...env, ...publicOrigin, ...modes } });
      expect(response.status).toBe(500);
    }
    expect(errors).toHaveBeenCalledWith('relay: dev-mode-refused');
    errors.mockRestore();
  });

  it('allow Turnstile off on a public origin, the production default', async () => {
    const send = vi.fn(async () => ({ messageId: 'x' }));
    const production = { ...env, ...publicOrigin, MAIL_TRANSPORT: 'cloudflare', TURNSTILE_MODE: 'off', EMAIL: { send } };
    const email = freshEmail();
    const response = await call('POST', '/relay/login', { json: { email, turnstile: 'none' }, env: production as typeof env });
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown as [{ to: string }])[0].to).toBe(email);
    const outboxRoute = await call('GET', '/relay/dev/outbox', { env: production as typeof env });
    expect(outboxRoute.status).toBe(404);
  });
});

describe('RELAY_MODE off (the production default)', () => {
  it('answers 404 on every relay path and sends no mail', async () => {
    const send = vi.fn(async () => ({ messageId: 'x' }));
    const off = { ...env, RELAY_MODE: 'off', MAIL_TRANSPORT: 'cloudflare', EMAIL: { send } } as typeof env;
    const id = newDocId();
    const responses = [
      await call('GET', '/relay/config', { env: off }),
      await call('POST', '/relay/login', { json: { email: freshEmail(), turnstile: 'none' }, env: off }),
      await call('PUT', `/relay/docs/${id}`, { headers: { 'X-Relay-To': freshEmail(), 'X-Relay-Password': '0', 'Content-Length': '8' }, body: blob(8), env: off }),
      await call('GET', `/relay/docs/${id}`, { env: off }),
      await call('GET', '/relay/dev/outbox', { env: off }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'not-found' });
    }
    expect(send).not.toHaveBeenCalled();
    // A missing var counts as off: a self-hosted copy must opt in.
    const { RELAY_MODE: _unset, ...missing } = env as typeof env & { RELAY_MODE?: string };
    expect((await call('GET', '/relay/config', { env: missing as typeof env })).status).toBe(404);
  });
});

describe('GET /relay/config', () => {
  it('gives the Turnstile site key, and none when Turnstile is off', async () => {
    const on = await call('GET', '/relay/config', {
      env: { ...env, TURNSTILE_MODE: 'on', TURNSTILE_SITE_KEY: 'site-key-1', PUBLIC_ORIGIN: 'http://127.0.0.1:8787' },
    });
    expect(await on.json()).toEqual({ turnstileSiteKey: 'site-key-1' });
    const off = await call('GET', '/relay/config', { env: { ...env, TURNSTILE_MODE: 'off', TURNSTILE_SITE_KEY: 'site-key-1' } });
    expect(await off.json()).toEqual({ turnstileSiteKey: '' });
  });
});

describe('every /relay response', () => {
  it('carries no-store and nosniff, success or error', async () => {
    const { a, b, session, id } = await sentDoc();
    const auth = { Authorization: `Bearer ${session}` };
    const responses = [
      await call('POST', '/relay/login', { json: { email: a, turnstile: 'x' } }),
      await call('POST', '/relay/login', { json: {} }),
      await call('POST', '/relay/login/verify', { json: { email: a, code: '000000' } }),
      await call('PUT', `/relay/docs/${newDocId()}`, { headers: auth }),
      await call('PUT', `/relay/docs/${newDocId()}`, { headers: { ...auth, 'X-Relay-To': b, 'X-Relay-Password': '0', 'Content-Length': '8' }, body: blob(8) }),
      await call('POST', `/relay/docs/${id}/send`, { headers: auth, json: { key: TEST_KEY } }),
      await call('GET', `/relay/docs/${id}`),
      await call('GET', `/relay/docs/${id}/final`),
      await call('PUT', `/relay/docs/${id}/final`, { headers: { 'Content-Length': '8' }, body: blob(8) }),
      await call('GET', `/relay/docs/${id}/final`, { headers: { 'X-Relay-Code': '000000' } }),
      await call('DELETE', `/relay/docs/${id}`),
      await call('GET', '/relay/dev/outbox'),
      await call('GET', '/relay/config'),
      await call('GET', '/relay/dev/outbox', { env: { ...env, MAIL_TRANSPORT: 'cloudflare' } }),
      await call('GET', '/relay/nothing'),
    ];
    const statuses = responses.map((r) => r.status);
    expect(new Set(statuses).size).toBeGreaterThan(4);
    for (const response of responses) {
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });
});

describe('GET /relay/dev/outbox', () => {
  it('lists mail in dev-outbox mode', async () => {
    const { b } = await sentDoc();
    const response = await call('GET', '/relay/dev/outbox');
    expect(response.status).toBe(200);
    const { messages } = (await response.json()) as { messages: { to: string; subject: string; text: string; at: string }[] };
    expect(messages.some((m) => m.to === b && m.text.includes('#relay='))).toBe(true);
  });

  it('is a 404 in any other mode', async () => {
    const response = await call('GET', '/relay/dev/outbox', { env: { ...env, MAIL_TRANSPORT: 'cloudflare' } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.', code: 'not-found' });
  });
});
