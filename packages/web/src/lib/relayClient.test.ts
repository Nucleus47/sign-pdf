import { describe, expect, it, vi } from 'vitest';
import { createRelayClient, RELAY_ERROR_TEXT, type RelaySession } from './relayClient.ts';
import type { FetchLike } from './transport.ts';

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const NOW = Date.parse('2026-10-07T12:00:00Z');
const SESSION: RelaySession = { session: 'payload.signature', expiresAt: '2026-10-08T12:00:00.000Z' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
  };
}

function client(fetchImpl: FetchLike, storage = memoryStorage()) {
  return { relay: createRelayClient({ fetch: fetchImpl, storage, now: () => NOW, jsonTimeoutMs: 50, uploadTimeoutMs: 50 }), storage };
}

/** Every request a fake fetch saw, as text that a key could hide in. */
async function everything(calls: Parameters<FetchLike>[]): Promise<string[]> {
  return Promise.all(
    calls.map(async ([url, init]) => {
      const headers = JSON.stringify(Object.fromEntries(new Headers(init?.headers).entries()));
      const body = init?.body instanceof Blob ? await init.body.text() : String(init?.body ?? '');
      return `${url}\n${headers}\n${body}`;
    }),
  );
}

describe('relay client', () => {
  it('asks for a code and verifies it, keeping the session in memory and sessionStorage', async () => {
    const fetchMock = vi.fn<FetchLike>((url) =>
      Promise.resolve(url.endsWith('/verify') ? json(SESSION) : json({ ok: true })),
    );
    const { relay, storage } = client(fetchMock);
    expect(relay.currentSession()).toBeNull();
    expect(await relay.login('a@example.com', 'tok')).toEqual({ ok: true, value: null });
    expect(await relay.verify('a@example.com', '123456')).toEqual({ ok: true, value: SESSION });

    const [loginUrl, loginInit] = fetchMock.mock.calls[0]!;
    expect(loginUrl).toBe('/relay/login');
    expect(loginInit?.method).toBe('POST');
    expect(JSON.parse(String(loginInit?.body))).toEqual({ email: 'a@example.com', turnstile: 'tok' });
    expect(loginInit?.credentials).toBe('omit');
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[1]!;
    expect(verifyUrl).toBe('/relay/login/verify');
    expect(JSON.parse(String(verifyInit?.body))).toEqual({ email: 'a@example.com', code: '123456' });

    expect(relay.currentSession()).toEqual(SESSION);
    // A new page in the same tab reads it back.
    const again = createRelayClient({ fetch: fetchMock, storage, now: () => NOW });
    expect(again.currentSession()).toEqual(SESSION);
  });

  it('drops a session that ran out, or that the relay refuses', async () => {
    const storage = memoryStorage();
    storage.setItem('sign-pdf.relay.session', JSON.stringify({ ...SESSION, expiresAt: '2026-10-07T11:59:59.000Z' }));
    const stale = createRelayClient({ fetch: vi.fn<FetchLike>(), storage, now: () => NOW });
    expect(stale.currentSession()).toBeNull();
    expect(storage.items.size).toBe(0);

    storage.setItem('sign-pdf.relay.session', JSON.stringify(SESSION));
    const refused = createRelayClient({
      fetch: () => Promise.resolve(json({ error: 'Sign in again.', code: 'unauthorized' }, 401)),
      storage,
      now: () => NOW,
    });
    expect(refused.currentSession()).toEqual(SESSION);
    const result = await refused.send(SESSION, ID, KEY);
    expect(result).toMatchObject({ ok: false, code: 'unauthorized', status: 401 });
    expect(refused.currentSession()).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('uploads the raw blob to the id it was encrypted for, with the documented headers', async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(json({ id: ID, expiresAt: '2026-10-14T12:00:00.000Z' })));
    const { relay } = client(fetchMock);
    const blob = new Uint8Array([0x53, 0x50, 0x52, 0x31, 9, 9]);
    const result = await relay.uploadHandoff(SESSION, { id: ID, to: 'b@example.com', password: true, blob });
    expect(result).toEqual({ ok: true, value: { id: ID, expiresAt: '2026-10-14T12:00:00.000Z' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/relay/docs/${ID}`);
    expect(init?.method).toBe('PUT');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer payload.signature');
    expect(headers.get('X-Relay-To')).toBe('b@example.com');
    expect(headers.get('X-Relay-Password')).toBe('1');
    expect(headers.get('Content-Length')).toBe('6');
    expect(new Uint8Array(await (init?.body as Blob).arrayBuffer())).toEqual(blob);
  });

  it('refuses an upload answer for another id', async () => {
    const other = 'EBESExQVFhcYGRobHB0eHw';
    const { relay } = client(() => Promise.resolve(json({ id: other, expiresAt: '2026-10-14T12:00:00.000Z' })));
    const result = await relay.uploadHandoff(SESSION, { id: ID, to: 'b@example.com', password: false, blob: new Uint8Array(4) });
    expect(result).toMatchObject({ ok: false, code: 'unexpected' });
  });

  it('sends the key in the body of /send only, and nowhere else in the whole flow', async () => {
    const fetchMock = vi.fn<FetchLike>((url) => {
      if (url === '/relay/config') return Promise.resolve(json({ turnstileSiteKey: '' }));
      if (url.endsWith('/verify')) return Promise.resolve(json(SESSION));
      if (url === `/relay/docs/${ID}`) return Promise.resolve(json({ id: ID, expiresAt: '2026-10-14T12:00:00.000Z' }));
      return Promise.resolve(json({ ok: true }));
    });
    const { relay, storage } = client(fetchMock);
    await relay.config();
    await relay.login('a@example.com', 'none');
    const session = await relay.verify('a@example.com', '123456');
    if (!session.ok) throw new Error('verify failed');
    await relay.uploadHandoff(session.value, { id: ID, to: 'b@example.com', password: false, blob: new Uint8Array(8) });
    expect(await relay.send(session.value, ID, KEY)).toEqual({ ok: true, value: null });

    const seen = await everything(fetchMock.mock.calls);
    const withKey = seen.filter((text) => text.includes(KEY));
    expect(withKey).toHaveLength(1);
    expect(withKey[0]).toMatch(new RegExp(`^/relay/docs/${ID}/send\\n`));
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(`/relay/docs/${ID}/send`);
    expect(url).not.toContain(KEY);
    expect(JSON.parse(String(init?.body))).toEqual({ key: KEY });
    expect([...storage.items.values()].join('')).not.toContain(KEY);
  });

  it.each([
    [401, 'bad-code', 'bad-code'],
    [401, 'unauthorized', 'unauthorized'],
    [413, 'too-large', 'too-large'],
    [429, 'rate-limited', 'rate-limited'],
    [409, 'already-sent', 'already-sent'],
    [409, 'id-taken', 'id-taken'],
    [409, 'send-pending', 'send-pending'],
    [404, 'not-found', 'not-found'],
    [502, 'email-failed', 'email-failed'],
    [500, 'server-error', 'server-error'],
    [400, 'bad-request', 'bad-request'],
  ] as const)('maps %i %s to its own words', async (status, given, code) => {
    const { relay } = client(() => Promise.resolve(json({ error: 'Server words with b@example.com', code: given }, status)));
    const result = await relay.send(SESSION, ID, KEY);
    expect(result).toEqual({ ok: false, code, status, error: RELAY_ERROR_TEXT[code] });
  });

  it.each([
    [401, 'unauthorized'],
    [413, 'too-large'],
    [429, 'rate-limited'],
    [409, 'already-sent'],
    [502, 'email-failed'],
    [503, 'server-error'],
    [404, 'not-available'],
  ] as const)('maps a bare %i, with no relay error body, by its status', async (status, code) => {
    const { relay } = client(() => Promise.resolve(new Response('nope', { status })));
    expect(await relay.config()).toMatchObject({ ok: false, code, status });
  });

  it('says the relay is unreachable on a network error or a timeout, never quoting the error', async () => {
    const { relay } = client(() => Promise.reject(new TypeError(`Failed to fetch ${KEY}`)));
    const failed = await relay.send(SESSION, ID, KEY);
    expect(failed).toEqual({ ok: false, code: 'unreachable', error: RELAY_ERROR_TEXT.unreachable });
    expect(JSON.stringify(failed)).not.toContain(KEY);

    const { relay: slow } = client(() => new Promise<Response>(() => undefined));
    expect(await slow.login('a@example.com', 'x')).toMatchObject({ ok: false, code: 'unreachable' });
  });

  it('refuses a 200 answer that is not the contract', async () => {
    const { relay } = client(() => Promise.resolve(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    // On /relay/config, a 200 that is not the contract means no relay here (the CLI or a static host answers index.html).
    expect(await relay.config()).toMatchObject({ ok: false, code: 'not-available' });
    expect(await relay.verify('a@example.com', '123456')).toMatchObject({ ok: false, code: 'unexpected' });
    expect(relay.currentSession()).toBeNull();
  });

  it('treats a JSON 200 from /relay/config that is not the contract as no relay', async () => {
    const { relay } = client(() => Promise.resolve(json({ status: 'ok' })));
    expect(await relay.config()).toMatchObject({ ok: false, code: 'not-available' });
  });

  it('reads the Turnstile site key from /relay/config', async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(json({ turnstileSiteKey: 'site-key' })));
    const { relay } = client(fetchMock);
    expect(await relay.config()).toEqual({ ok: true, value: { turnstileSiteKey: 'site-key' } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/relay/config');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });
});

describe('relay client, the next signer', () => {
  const blob = new Uint8Array([0x53, 0x50, 0x52, 0x31, 1, 2, 3]);
  const raw = (bytes: Uint8Array, headers: Record<string, string>, status = 200) =>
    new Response(bytes.slice(), { status, headers: { 'content-type': 'application/octet-stream', ...headers } });

  it('fetches the hand-off as raw bytes with the password flag, no credentials, no store', async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(raw(blob, { 'X-Relay-Password': '1' })));
    const { relay } = client(fetchMock);
    const result = await relay.fetchHandoff(ID);
    expect(result).toEqual({ ok: true, value: { blob, password: true } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/relay/docs/${ID}`);
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('maps a missing document to not-found and too many requests to rate-limited', async () => {
    const notFound = client(() => Promise.resolve(json({ error: 'Not found.', code: 'not-found' }, 404))).relay;
    expect(await notFound.fetchHandoff(ID)).toMatchObject({ ok: false, code: 'not-found', status: 404 });
    const limited = client(() => Promise.resolve(json({ error: 'Slow down.', code: 'rate-limited' }, 429))).relay;
    expect(await limited.fetchHandoff(ID)).toMatchObject({ ok: false, code: 'rate-limited', status: 429 });
  });

  it('stops reading a body without a length once it passes the cap', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const { relay } = client(() => Promise.resolve(new Response(body, { headers: { 'X-Relay-Password': '0' } })));
    expect(await relay.fetchHandoff(ID)).toMatchObject({ ok: false, code: 'too-large' });
    expect(pulled).toBeLessThan(10);
  });

  it('refuses an answer without the password flag', async () => {
    const { relay } = client(() => Promise.resolve(raw(blob, {})));
    expect(await relay.fetchHandoff(ID)).toMatchObject({ ok: false, code: 'unexpected' });
  });

  it('uploads the final as raw bytes to /final with its length and no sign-in', async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(json({ ok: true })));
    const { relay } = client(fetchMock);
    expect(await relay.uploadFinal(ID, blob)).toEqual({ ok: true, value: null });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/relay/docs/${ID}/final`);
    expect(init?.method).toBe('PUT');
    const headers = new Headers(init?.headers);
    expect(headers.get('content-length')).toBe(String(blob.byteLength));
    expect(headers.has('authorization')).toBe(false);
    expect(new Uint8Array(await (init?.body as Blob).arrayBuffer())).toEqual(blob);
  });

  it('maps final-exists to already-sent and 413 to too-large', async () => {
    const exists = client(() => Promise.resolve(json({ error: 'x', code: 'final-exists' }, 409))).relay;
    expect(await exists.uploadFinal(ID, blob)).toMatchObject({ ok: false, code: 'already-sent' });
    const large = client(() => Promise.resolve(json({ error: 'x', code: 'too-large' }, 413))).relay;
    expect(await large.uploadFinal(ID, blob)).toMatchObject({ ok: false, code: 'too-large' });
  });
});

describe('relay client, the first signer collects the signed PDF', () => {
  const raw = (bytes: number[], status = 200) =>
    new Response(new Uint8Array(bytes), { status, headers: { 'content-type': 'application/octet-stream' } });

  it('fetches the final with the code in X-Relay-Code, no credentials, no store', async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(raw([1, 2, 3])));
    const { relay } = client(fetchMock);
    const result = await relay.fetchFinal(ID, '123456');
    expect(result).toEqual({ ok: true, value: { blob: new Uint8Array([1, 2, 3]) } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/relay/docs/${ID}/final`);
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('x-relay-code')).toBe('123456');
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
  });

  it('returns the wrapped key from X-Relay-Wrapped-Key, and refuses a malformed one', async () => {
    const wrapped = 'A'.repeat(80);
    const withKey = (value: string) => () =>
      Promise.resolve(
        new Response(new Uint8Array([4, 5]), {
          headers: { 'content-type': 'application/octet-stream', 'x-relay-wrapped-key': value },
        }),
      );
    expect(await client(withKey(wrapped)).relay.fetchFinal(ID, '123456')).toEqual({
      ok: true,
      value: { blob: new Uint8Array([4, 5]), wrappedKey: wrapped },
    });
    expect(await client(withKey('A'.repeat(79))).relay.fetchFinal(ID, '123456')).toMatchObject({ ok: false, code: 'unexpected' });
  });

  it('sends the wrapped key in the body of /send, next to the key', async () => {
    const wrapped = 'B'.repeat(80);
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(json({ ok: true })));
    const { relay } = client(fetchMock);
    expect(await relay.send(SESSION, ID, KEY, wrapped)).toEqual({ ok: true, value: null });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ key: KEY, wrappedKey: wrapped });
    await relay.send(SESSION, ID, KEY);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ key: KEY });
  });

  it('refuses a code that is not 6 digits without a request', async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(raw([1])));
    const { relay } = client(fetchMock);
    expect(await relay.fetchFinal(ID, '12345')).toMatchObject({ ok: false, code: 'bad-code' });
    expect(await relay.fetchFinal(ID, '12345a')).toMatchObject({ ok: false, code: 'bad-code' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a wrong code to bad-code and a gone final to not-found', async () => {
    const wrong = client(() => Promise.resolve(json({ error: 'x', code: 'bad-code' }, 401))).relay;
    expect(await wrong.fetchFinal(ID, '000000')).toMatchObject({ ok: false, code: 'bad-code', status: 401 });
    const gone = client(() => Promise.resolve(json({ error: 'x', code: 'not-found' }, 404))).relay;
    expect(await gone.fetchFinal(ID, '000000')).toMatchObject({ ok: false, code: 'not-found', status: 404 });
  });

  it('deletes the document with DELETE and takes 204 as done', async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 204 })));
    const { relay } = client(fetchMock);
    expect(await relay.deleteDoc(ID)).toEqual({ ok: true, value: null });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/relay/docs/${ID}`);
    expect(init?.method).toBe('DELETE');
    expect(init?.credentials).toBe('omit');
    expect(init?.body).toBeUndefined();
  });

  it('reports a failed delete without throwing', async () => {
    const down = client(() => Promise.reject(new Error('offline'))).relay;
    expect(await down.deleteDoc(ID)).toMatchObject({ ok: false, code: 'unreachable' });
    const limited = client(() => Promise.resolve(new Response(null, { status: 429 }))).relay;
    expect(await limited.deleteDoc(ID)).toMatchObject({ ok: false, code: 'rate-limited' });
  });
});
