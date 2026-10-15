import { describe, expect, it, vi } from 'vitest';
import {
  fetchSessionPacket,
  hashWithoutSession,
  markSessionLinkUsed,
  openSession,
  postDeclined,
  postSigned,
  readSessionNonce,
  removeSessionFromAddressBar,
  takeSessionLinkUsed,
  type FetchLike,
  postHandedOff,
} from './transport.ts';

const TOKEN = 'tok-123_abc';
const NONCE = 'nonce-456_def';
const packetText = JSON.stringify({ kind: 'sign-pdf-packet', version: 1, request: {}, pdfBase64: 'AA==' });

function fetchReturning(response: Response) {
  return vi.fn<FetchLike>(() => Promise.resolve(response));
}

function json(body: string, status = 200, type = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

describe('session nonce in the URL', () => {
  it('reads the nonce from the fragment', () => {
    expect(readSessionNonce(`#session=${TOKEN}`)).toBe(TOKEN);
    expect(readSessionNonce(`#view=sign&session=${TOKEN}`)).toBe(TOKEN);
    expect(readSessionNonce(`#/sign?session=${TOKEN}&x=1`)).toBe(TOKEN);
    expect(readSessionNonce('#session=a%2Bb')).toBe('a+b');
  });

  it('finds no nonce when there is none', () => {
    expect(readSessionNonce('')).toBeNull();
    expect(readSessionNonce('#')).toBeNull();
    expect(readSessionNonce('#session=')).toBeNull();
    expect(readSessionNonce('#mysession=abc')).toBeNull();
  });

  it('removes the nonce from the address bar and keeps the rest', () => {
    expect(hashWithoutSession(`#session=${TOKEN}`)).toBe('');
    expect(hashWithoutSession(`#a=1&session=${TOKEN}&b=2`)).toBe('#a=1&b=2');
    const replaceState = vi.fn();
    removeSessionFromAddressBar(
      { pathname: '/', search: '?x=1', hash: `#session=${TOKEN}` },
      { replaceState, state: null },
    );
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?x=1');
  });
});

describe('the mark of a used signing link', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { items: Map<string, string> } {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => void items.set(key, value),
      removeItem: (key) => void items.delete(key),
    };
  }

  it('is true once after the link was used, and stores no secret', () => {
    const storage = memoryStorage();
    expect(takeSessionLinkUsed(storage)).toBe(false);
    markSessionLinkUsed(storage);
    expect([...storage.items.values()]).toEqual(['1']);
    expect(takeSessionLinkUsed(storage)).toBe(true);
    expect(takeSessionLinkUsed(storage)).toBe(false);
  });

  it('is false without storage or when the storage throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    expect(() => markSessionLinkUsed(throwing)).not.toThrow();
    expect(takeSessionLinkUsed(throwing)).toBe(false);
    markSessionLinkUsed(undefined);
    expect(takeSessionLinkUsed(undefined)).toBe(false);
  });
});

describe('POST /api/session', () => {
  const error = (code: string, status: number) => json(JSON.stringify({ error: 'A sentence.', code }), status);

  it('posts the nonce as JSON, with no Authorization header, and returns the token', async () => {
    const fetchImpl = fetchReturning(json(JSON.stringify({ token: TOKEN })));
    expect(await openSession(NONCE, fetchImpl)).toEqual({ ok: true, token: TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/session');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({ nonce: NONCE });
  });

  it('reports a link that was opened before', async () => {
    const result = await openSession(NONCE, fetchReturning(error('session-already-opened', 401)));
    expect(result).toMatchObject({ ok: false, problem: 'already-opened' });
  });

  it.each([
    ['invalid-nonce', 401],
    ['session-locked', 429],
    ['session-finished', 409],
    ['forbidden', 403],
    ['bad-request', 400],
  ])('reports %s as a link that is not valid', async (code, status) => {
    const result = await openSession(NONCE, fetchReturning(error(code, status)));
    expect(result).toMatchObject({ ok: false, problem: 'not-valid' });
  });

  it.each([
    ['the static site shell (200 HTML)', json('<!doctype html>', 200, 'text/html')],
    ['a 404 HTML page', json('<!doctype html>', 404, 'text/html')],
    ['a 405 with no body', new Response(null, { status: 405 })],
    ['JSON with no token', json('{}')],
    ['an empty token', json('{"token":""}')],
    ['a token that is not a string', json('{"token":7}')],
    ['broken JSON', json('{')],
    ['a token served as text/plain', json(JSON.stringify({ token: TOKEN }), 200, 'text/plain')],
  ])('treats %s as no session', async (_name, response) => {
    const result = await openSession(NONCE, fetchReturning(response));
    expect(result).toMatchObject({ ok: false, problem: 'not-valid' });
  });

  it('treats a network failure and a timeout as something to try again', async () => {
    const failed = await openSession(NONCE, vi.fn<FetchLike>(() => Promise.reject(new TypeError('failed'))));
    expect(failed).toEqual({ ok: false, problem: 'unreachable', reason: 'The requesting app did not answer.' });
    vi.useFakeTimers();
    try {
      const never = vi.fn<FetchLike>(() => new Promise<Response>(() => undefined));
      const waiting = openSession(NONCE, never, 3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await waiting).toEqual({
        ok: false,
        problem: 'unreachable',
        reason: 'The requesting app did not answer within 3 seconds.',
      });
      expect(never.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GET /api/packet', () => {
  it('sends the bearer token and returns the packet text when a session is active', async () => {
    const fetchImpl = fetchReturning(json(packetText));
    const result = await fetchSessionPacket(TOKEN, fetchImpl);
    expect(result).toEqual({ active: true, packetText });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/packet');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it('accepts a content type with a charset', async () => {
    const result = await fetchSessionPacket(TOKEN, fetchReturning(json(packetText, 200, 'application/json; charset=utf-8')));
    expect(result.active).toBe(true);
  });

  it.each([
    ['a 401', json('{"error":"no"}', 401)],
    ['a 404 HTML page', json('<!doctype html>', 404, 'text/html')],
    ['the static site shell (200 HTML)', json('<!doctype html>', 200, 'text/html')],
    ['JSON that is not a packet', json('{"kind":"something-else"}')],
    ['broken JSON', json('{')],
    ['a packet served as text/plain', json(packetText, 200, 'text/plain')],
  ])('treats %s as no session', async (_name, response) => {
    const result = await fetchSessionPacket(TOKEN, fetchReturning(response));
    expect(result).toMatchObject({ active: false, problem: 'not-valid' });
  });

  it('reports a finished session as a link that is no longer valid', async () => {
    const result = await fetchSessionPacket(TOKEN, fetchReturning(json('{"error":"Done.","code":"session-finished"}', 409)));
    expect(result).toEqual({ active: false, problem: 'not-valid', reason: 'The request is already finished.' });
  });

  it('treats a network failure as something to try again', async () => {
    const result = await fetchSessionPacket(TOKEN, vi.fn<FetchLike>(() => Promise.reject(new TypeError('failed'))));
    expect(result).toEqual({ active: false, problem: 'unreachable', reason: 'The requesting app did not answer.' });
  });

  it('gives up after the time limit, aborts the request and says how long it waited', async () => {
    vi.useFakeTimers();
    try {
      const never = vi.fn<FetchLike>(() => new Promise<Response>(() => undefined));
      const waiting = fetchSessionPacket(TOKEN, never);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(never.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await waiting).toEqual({
        active: false,
        problem: 'unreachable',
        reason: 'The requesting app did not answer within 15 seconds.',
      });
      expect(never.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      // Asking again afterwards works.
      expect(await fetchSessionPacket(TOKEN, fetchReturning(json(packetText)))).toEqual({ active: true, packetText });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the time limit to a body that never ends', async () => {
    vi.useFakeTimers();
    try {
      const stalled = { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: () => new Promise<string>(() => undefined) };
      const waiting = fetchSessionPacket(TOKEN, () => Promise.resolve(stalled as unknown as Response), 2_000); // a double: only the fields read
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await waiting).toMatchObject({ active: false, problem: 'unreachable', reason: expect.stringContaining('2 seconds') });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /api/signed', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
  const sha = 'c'.repeat(64);

  it('posts the exact bytes with the contract headers', async () => {
    const fetchImpl = fetchReturning(new Response(null, { status: 204 }));
    expect(await postSigned(TOKEN, pdf, sha, fetchImpl)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/signed');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/pdf',
      'X-Sign-Pdf-Sha256': sha,
    });
    const body = init?.body;
    expect(body).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (body as Blob).arrayBuffer())).toEqual(pdf);
  });

  it('sends only the view when the bytes sit in a larger buffer', async () => {
    const backing = new Uint8Array([9, 9, ...pdf, 9, 9]);
    const view = backing.subarray(2, 2 + pdf.length);
    const fetchImpl = fetchReturning(new Response(null, { status: 200 }));
    await postSigned(TOKEN, view, sha, fetchImpl);
    const body = fetchImpl.mock.calls[0]?.[1]?.body as Blob;
    expect(new Uint8Array(await body.arrayBuffer())).toEqual(pdf);
  });

  it('reports a failure status and a network failure', async () => {
    expect(await postSigned(TOKEN, pdf, sha, fetchReturning(new Response('no', { status: 500 })))).toEqual({
      ok: false,
      status: 500,
      error: 'The requesting app answered with status 500.',
    });
    const failed = await postSigned(TOKEN, pdf, sha, vi.fn<FetchLike>(() => Promise.reject(new TypeError('offline'))));
    expect(failed.ok).toBe(false);
  });

  it.each([
    ['not-a-pdf', 422, 'could not read the signed PDF'],
    ['unchanged-document', 422, 'nothing signed in it'],
    ['no-audit-record', 422, 'no signing record'],
    ['wrong-document', 422, 'a different document'],
    ['wrong-request', 422, 'a different signature request'],
    ['incomplete-audit-record', 422, 'does not cover every field'],
    ['missing-signature', 422, 'required signature or initials'],
    ['unchanged-page', 422, 'nothing drawn on it'],
    ['save-failed', 500, 'could not save it'],
    ['session-finished', 409, 'already closed this request'],
    ['body-too-large', 413, 'larger than the requesting app accepts'],
    ['unauthorized', 401, 'did not accept this page'],
  ])('explains the code %s in plain words', async (code, status, words) => {
    const response = json(JSON.stringify({ error: 'Server sentence.', code }), status);
    const result = await postSigned(TOKEN, pdf, sha, fetchReturning(response));
    expect(result).toMatchObject({ ok: false, code, error: expect.stringContaining(words) });
  });

  it('keeps an unknown code and falls back to the status', async () => {
    const response = json('{"error":"Odd.","code":"brand-new"}', 418);
    expect(await postSigned(TOKEN, pdf, sha, fetchReturning(response))).toEqual({
      ok: false,
      status: 418,
      code: 'brand-new',
      error: 'The requesting app answered with status 418 (brand-new).',
    });
  });
});

describe('POST /api/signed again', () => {
  it('re-posts the same bytes and headers after a failure', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 8, 7]);
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response('no', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await postSigned(TOKEN, pdf, 'c'.repeat(64), fetchImpl)).toEqual({
      ok: false,
      status: 503,
      error: 'The requesting app answered with status 503.',
    });
    expect(await postSigned(TOKEN, pdf, 'c'.repeat(64), fetchImpl)).toEqual({ ok: true });
    const bodies = await Promise.all(
      fetchImpl.mock.calls.map(async ([, init]) => new Uint8Array(await (init?.body as Blob).arrayBuffer())),
    );
    expect(bodies[0]).toEqual(pdf);
    expect(bodies[1]).toEqual(pdf);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual(fetchImpl.mock.calls[0]?.[1]?.headers);
  });

  it('reports a hand-back that gets no answer in time', async () => {
    vi.useFakeTimers();
    try {
      const waiting = postSigned(TOKEN, new Uint8Array([1]), 'c'.repeat(64), () => new Promise<Response>(() => undefined), 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await waiting).toEqual({ ok: false, error: 'The requesting app did not answer within 5 seconds.' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /api/declined', () => {
  it('posts the reason as JSON', async () => {
    const fetchImpl = fetchReturning(new Response(null, { status: 200 }));
    expect(await postDeclined(TOKEN, '  Wrong name  ', fetchImpl)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/declined');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Wrong name' });
  });

  it('sends an empty reason when none is given', async () => {
    const fetchImpl = fetchReturning(new Response(null, { status: 200 }));
    await postDeclined(TOKEN, '', fetchImpl);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ reason: '' });
  });
});

describe('POST /api/handed-off', () => {
  it('sends exactly { signerId } with the token, and keeps the status of a failure', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    expect(await postHandedOff(TOKEN, 'a', fetchImpl)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/handed-off');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({ signerId: 'a' });
    // An older local app without the route answers 404: the sign view tolerates it.
    expect(await postHandedOff(TOKEN, 'a', fetchImpl)).toMatchObject({ ok: false, status: 404 });
  });

  it('explains wrong-signer', async () => {
    const response = new Response('{"error":"No.","code":"wrong-signer"}', { status: 422, headers: { 'content-type': 'application/json' } });
    expect(await postHandedOff(TOKEN, 'b', vi.fn<FetchLike>(() => Promise.resolve(response)))).toMatchObject({
      ok: false,
      code: 'wrong-signer',
      error: expect.stringContaining('not waiting for this signer'),
    });
  });
});
