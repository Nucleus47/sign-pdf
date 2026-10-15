import sendSource from './handlers/send.ts?raw';
import { RELAY_MAX_BLOB_BYTES } from '@sign-pdf/spec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setClockOffsetForTests } from './clock.ts';
import { newDocId } from './crypto.ts';
import { keys } from './storage.ts';
import {
  TEST_KEY,
  TEST_WRAPPED_KEY,
  blob,
  call,
  env,
  freshEmail,
  lastMailTo,
  sentDoc,
  signIn,
  uploadDoc,
} from './testing.ts';

afterEach(() => {
  setClockOffsetForTests(0);
  vi.restoreAllMocks();
});

const DAY = 24 * 60 * 60 * 1000;

function uploadHeaders(session: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${session}`, 'X-Relay-To': 'b@example.com', 'X-Relay-Password': '0', ...extra };
}

describe('PUT /relay/docs/:id', () => {
  it('stores the blob under the id the browser chose, with its metadata and a 7-day expiry', async () => {
    const a = freshEmail('a');
    const session = await signIn(a);
    const bytes = blob(1000, 3);
    const chosen = newDocId();
    const { id, expiresAt } = await uploadDoc(session, ' B@Example.com ', bytes, '1', chosen);
    expect(id).toBe(chosen);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(7 * DAY - 60_000);
    const object = await env.BLOBS.get(keys.handoff(id));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
    expect(object!.customMetadata).toMatchObject({ from: a, to: 'b@example.com', password: '1' });
  });

  it('refuses a body over the cap by its Content-Length, before reading it', async () => {
    const session = await signIn(freshEmail());
    const response = await call('PUT', `/relay/docs/${newDocId()}`, {
      headers: uploadHeaders(session, { 'Content-Length': String(RELAY_MAX_BLOB_BYTES + 1) }),
      body: new Uint8Array(8),
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe('too-large');
  });

  it('refuses a body longer than its Content-Length and stores nothing', async () => {
    const session = await signIn(freshEmail());
    const before = (await env.BLOBS.list({ prefix: 'relay/' })).objects.filter((o) => o.key.endsWith('handoff.bin')).length;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    });
    const response = await call('PUT', `/relay/docs/${newDocId()}`, {
      headers: uploadHeaders(session, { 'Content-Length': '10' }),
      body: stream,
    });
    expect(response.status).toBe(413);
    const after = (await env.BLOBS.list({ prefix: 'relay/' })).objects.filter((o) => o.key.endsWith('handoff.bin')).length;
    expect(after).toBe(before);
  });

  it('requires Content-Length', async () => {
    const session = await signIn(freshEmail());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    });
    const response = await call('PUT', `/relay/docs/${newDocId()}`, { headers: uploadHeaders(session), body: stream });
    expect(response.status).toBe(411);
    expect(((await response.json()) as { code: string }).code).toBe('bad-request');
  });

  it('refuses an id that is in use, and never replaces its blob', async () => {
    const session = await signIn(freshEmail());
    const { id } = await uploadDoc(session, 'b@example.com', blob(16, 1));
    const again = await call('PUT', `/relay/docs/${id}`, {
      headers: uploadHeaders(session, { 'Content-Length': '16' }),
      body: blob(16, 2),
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('id-taken');
    const object = await env.BLOBS.get(keys.handoff(id));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(blob(16, 1));
  });

  it('refuses an id whose hand-off is gone but whose final or send marker remains', async () => {
    const { session, id } = await sentDoc();
    await env.BLOBS.delete(keys.handoff(id));
    const response = await call('PUT', `/relay/docs/${id}`, {
      headers: uploadHeaders(session, { 'Content-Length': '4' }),
      body: blob(4),
    });
    expect(response.status).toBe(409);
  });

  it('answers 404 for an id that is not one, and for the old unaddressed route', async () => {
    const session = await signIn(freshEmail());
    for (const path of ['/relay/docs/short', '/relay/docs']) {
      const response = await call('PUT', path, { headers: uploadHeaders(session, { 'Content-Length': '4' }), body: blob(4) });
      expect(response.status).toBe(404);
    }
  });

  it('validates X-Relay-To and X-Relay-Password', async () => {
    const session = await signIn(freshEmail());
    const cases: Record<string, string>[] = [
      { 'X-Relay-To': 'not-an-email' },
      { 'X-Relay-To': 'b@example.com, victim@example.com' },
      { 'X-Relay-To': '"Boss" <b@example.com>' },
      { 'X-Relay-Password': '2' },
    ];
    for (const extra of cases) {
      const response = await call('PUT', `/relay/docs/${newDocId()}`, {
        headers: uploadHeaders(session, { ...extra, 'Content-Length': '4' }),
        body: new Uint8Array(4),
      });
      expect(response.status).toBe(400);
    }
  });
});

describe('POST /relay/docs/:id/send', () => {
  it('emails the next signer once, with Reply-To set to the sender', async () => {
    const { a, b, session, id } = await sentDoc();
    const mail = await lastMailTo(b);
    expect(mail?.replyTo).toBe(a);
    expect(mail?.subject).toBe('A document is waiting for your signature');
    expect(mail?.text).toContain(`${env.PUBLIC_ORIGIN}/#relay=${id}&k=${TEST_KEY}`);
    expect(mail?.text).not.toContain('&p=1');
    expect(mail?.text).not.toContain('password');

    const again = await call('POST', `/relay/docs/${id}/send`, {
      headers: { Authorization: `Bearer ${session}` },
      json: { key: TEST_KEY },
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('already-sent');
  });

  it('adds p=1 and the password line when the sender set a password', async () => {
    const { b, id } = await sentDoc('1');
    const mail = await lastMailTo(b);
    expect(mail?.text).toContain(`#relay=${id}&k=${TEST_KEY}&p=1`);
    expect(mail?.text).toContain('You will need the password');
  });

  it('answers 404 to anyone but the uploader', async () => {
    const session = await signIn(freshEmail('a'));
    const { id } = await uploadDoc(session, freshEmail('b'));
    const other = await signIn(freshEmail('m'));
    const response = await call('POST', `/relay/docs/${id}/send`, {
      headers: { Authorization: `Bearer ${other}` },
      json: { key: TEST_KEY },
    });
    expect(response.status).toBe(404);
  });

  it('lets the sender retry after a mail failure, and reports the code', async () => {
    const session = await signIn(freshEmail('a'));
    const { id } = await uploadDoc(session, freshEmail('b'));
    const failing = {
      ...env,
      MAIL_TRANSPORT: 'cloudflare',
      EMAIL: {
        send: async () => {
          throw Object.assign(new Error('x'), { code: 'E_RATE_LIMIT_EXCEEDED' });
        },
      },
    } as unknown as typeof env;
    const log = vi.spyOn(console, 'error');
    const failed = await call('POST', `/relay/docs/${id}/send`, {
      headers: { Authorization: `Bearer ${session}` },
      json: { key: TEST_KEY },
      env: failing,
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: 'email-failed' });
    expect(log).not.toHaveBeenCalled();
    const retry = await call('POST', `/relay/docs/${id}/send`, {
      headers: { Authorization: `Bearer ${session}` },
      json: { key: TEST_KEY },
    });
    expect(retry.status).toBe(200);
  });

  it('takes over a pending claim left by a send that died, but not a fresh one', async () => {
    const session = await signIn(freshEmail('a'));
    const b = freshEmail('b');
    const { id } = await uploadDoc(session, b);
    const send = () =>
      call('POST', `/relay/docs/${id}/send`, { headers: { Authorization: `Bearer ${session}` }, json: { key: TEST_KEY } });
    const codeOf = async (response: Response) => [response.status, ((await response.json()) as { code: string }).code];
    await env.BLOBS.put(keys.sent(id), JSON.stringify({ state: 'pending', at: Date.now() }));
    // A send still running can fail: it is told apart from one that went out.
    expect(await codeOf(await send())).toEqual([409, 'send-pending']);
    await env.BLOBS.put(keys.sent(id), JSON.stringify({ state: 'pending', at: Date.now() - 61_000 }));
    expect((await send()).status).toBe(200);
    expect(await lastMailTo(b)).toBeDefined();
    expect(await codeOf(await send())).toEqual([409, 'already-sent']);
  });

  it('refuses a malformed key', async () => {
    const session = await signIn(freshEmail('a'));
    const { id } = await uploadDoc(session, freshEmail('b'));
    const response = await call('POST', `/relay/docs/${id}/send`, {
      headers: { Authorization: `Bearer ${session}` },
      json: { key: 'short' },
    });
    expect(response.status).toBe(400);
  });

  describe('the wrapped key (issue #105)', () => {
    const sendWith = (id: string, session: string, json: unknown) =>
      call('POST', `/relay/docs/${id}/send`, { headers: { Authorization: `Bearer ${session}` }, json });
    const answer = async (response: Response) => [response.status, ((await response.json()) as { code: string }).code];

    it('stores it with the sent marker when the password flag is set', async () => {
      const { id } = await sentDoc('1');
      const marker = (await (await env.BLOBS.get(keys.sent(id)))!.json()) as { state: string; wrappedKey?: string };
      expect(marker).toMatchObject({ state: 'sent', wrappedKey: TEST_WRAPPED_KEY });
    });

    it('requires it when the password flag is set, and emails no one without it', async () => {
      const session = await signIn(freshEmail('a'));
      const b = freshEmail('b');
      const { id } = await uploadDoc(session, b, blob(64), '1');
      expect(await answer(await sendWith(id, session, { key: TEST_KEY }))).toEqual([400, 'bad-wrapped-key']);
      expect(await lastMailTo(b)).toBeUndefined();
      expect(await env.BLOBS.head(keys.sent(id))).toBeNull();
      // The right request still works afterwards.
      expect((await sendWith(id, session, { key: TEST_KEY, wrappedKey: TEST_WRAPPED_KEY })).status).toBe(200);
    });

    it.each([
      ['short', TEST_WRAPPED_KEY.slice(1)],
      ['long', `${TEST_WRAPPED_KEY}A`],
      ['not base64url', `${TEST_WRAPPED_KEY.slice(1)}+`],
      ['not a string', 42],
    ])('refuses a %s wrapped key', async (_name, wrappedKey) => {
      const session = await signIn(freshEmail('a'));
      const b = freshEmail('b');
      const { id } = await uploadDoc(session, b, blob(64), '1');
      expect(await answer(await sendWith(id, session, { key: TEST_KEY, wrappedKey }))).toEqual([400, 'bad-wrapped-key']);
      expect(await lastMailTo(b)).toBeUndefined();
    });

    it('refuses one when the password flag is not set', async () => {
      const session = await signIn(freshEmail('a'));
      const b = freshEmail('b');
      const { id } = await uploadDoc(session, b, blob(64), '0');
      const response = await sendWith(id, session, { key: TEST_KEY, wrappedKey: TEST_WRAPPED_KEY });
      expect(await answer(response)).toEqual([400, 'bad-wrapped-key']);
      expect(await lastMailTo(b)).toBeUndefined();
    });

    it('answers 404, not the flag check, to anyone but the uploader', async () => {
      const session = await signIn(freshEmail('a'));
      const { id } = await uploadDoc(session, freshEmail('b'), blob(64), '1');
      const other = await signIn(freshEmail('m'));
      expect((await sendWith(id, other, { key: TEST_KEY })).status).toBe(404);
    });

    it('logs nothing that holds it', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const info = vi.spyOn(console, 'log').mockImplementation(() => {});
      await sentDoc('1');
      const printed = [...log.mock.calls, ...info.mock.calls].flat().join(' ');
      expect(printed).not.toContain(TEST_WRAPPED_KEY);
    });
  });

  it('has no logging in the handler source', () => {
    expect(sendSource).not.toMatch(/console/);
    expect(sendSource).not.toMatch(/logMailFailure/);
  });
});

describe('GET and DELETE /relay/docs/:id', () => {
  it('returns the ciphertext with the password flag', async () => {
    const session = await signIn(freshEmail('a'));
    const bytes = blob(100, 5);
    const { id } = await uploadDoc(session, freshEmail('b'), bytes, '1');
    const response = await call('GET', `/relay/docs/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Relay-Password')).toBe('1');
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('answers 404 after expiry and deletes the document', async () => {
    const { id } = await sentDoc();
    setClockOffsetForTests(7 * DAY + 1);
    expect((await call('GET', `/relay/docs/${id}`)).status).toBe(404);
    setClockOffsetForTests(0);
    expect(await env.BLOBS.head(keys.handoff(id))).toBeNull();
    expect(await env.BLOBS.head(keys.sent(id))).toBeNull();
  });

  it('answers the same 404 to a missing id and a malformed one', async () => {
    const missing = await call('GET', '/relay/docs/AAAAAAAAAAAAAAAAAAAAAA');
    const malformed = await call('GET', '/relay/docs/..%2F..%2Flogin');
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await missing.text()).toBe(await malformed.text());
  });

  it('deletes with 204, every time', async () => {
    const { id } = await sentDoc();
    for (let i = 0; i < 2; i++) {
      const response = await call('DELETE', `/relay/docs/${id}`);
      expect(response.status).toBe(204);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(await env.BLOBS.head(keys.handoff(id))).toBeNull();
    expect((await call('DELETE', '/relay/docs/not-an-id')).status).toBe(204);
  });
});
