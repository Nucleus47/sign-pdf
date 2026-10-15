import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PDFDocument } from '@cantoo/pdf-lib';
import { createPacket, encodePacket, sha256Hex, verifySignedPdf } from '@sign-pdf/core';
import { AUDIT_ATTACHMENT_NAME, type AuditRecord } from '@sign-pdf/spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openInDefaultBrowser } from './open-browser.ts';
import { MAX_BAD_NONCES, startSignSession, type SignSession, type SignSessionOptions } from './session.ts';
import { startSignRequest } from './sign-request.ts';
import { summarizeAudit } from './audit.ts';
import {
  FIXTURE_INDEX_HTML,
  exchangeNonce,
  fixturePdf,
  http,
  isClosed,
  rect,
  requestFor,
  runCli,
  signAsHuman,
  signInBrowser,
  workspace,
  type Workspace,
} from './test-helpers.ts';

let ws: Workspace;
let webDir: string;
let pdf: Uint8Array;
const sessions: SignSession[] = [];

beforeEach(async () => {
  ws = await workspace();
  webDir = await ws.webDir();
  pdf = await fixturePdf();
});

afterEach(async () => {
  // Every server a test started is closed, whatever the test's outcome.
  for (const session of sessions.splice(0)) {
    await session.close();
    expect(await isClosed(session.port)).toBe(true);
  }
  await ws.cleanup();
});

/** The token each session gave out when `start` played the page's nonce exchange. */
const tokens = new WeakMap<SignSession, string>();

/** A session whose link nobody has opened yet. */
async function startUnopened(options: Partial<SignSessionOptions> = {}): Promise<SignSession> {
  const session = await startSignSession({
    packet: await createPacket(pdf, await requestFor(pdf)),
    webDir,
    timeoutMs: 20_000,
    ...options,
  });
  sessions.push(session);
  return session;
}

/** A session whose nonce has been exchanged, as the sign view does on load. */
async function start(options: Partial<SignSessionOptions> = {}): Promise<SignSession> {
  const session = await startUnopened(options);
  tokens.set(session, await exchangeNonce(session.port, session.url));
  return session;
}

function tokenOf(session: SignSession): string {
  const token = tokens.get(session);
  if (token === undefined) throw new Error('This session was not opened by start().');
  return token;
}

const nonceOf = (session: SignSession): string => new URL(session.url).hash.replace('#session=', '');

const auth = (session: SignSession) => ({ Authorization: `Bearer ${tokenOf(session)}` });

const postNonce = (session: SignSession, nonce: unknown, headers: Record<string, string> = {}) =>
  http(session.port, {
    method: 'POST',
    path: '/api/session',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ nonce }),
  });

function signedHeaders(session: SignSession, sha256: string): Record<string, string> {
  return { ...auth(session), 'Content-Type': 'application/pdf', 'X-Sign-Pdf-Sha256': sha256 };
}

/** Race a promise against a short delay to show it has not settled. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), 50))]);
  return winner === marker;
}

describe('session set-up', () => {
  it('listens on loopback only, on a random port, with a long URL-safe one-time nonce in the fragment', async () => {
    const session = await startUnopened();
    expect(session.port).toBeGreaterThan(0);
    expect(session.origin).toBe(`http://127.0.0.1:${session.port}`);
    const url = new URL(session.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#session=[A-Za-z0-9_-]{43,}$/);
    expect(session.url).toBe(`${session.origin}/#session=${nonceOf(session)}`);
    // The session object carries no token: only the exchange gives it out.
    expect(Object.keys(session)).not.toContain('token');
    expect(nonceOf(await startUnopened())).not.toBe(nonceOf(session));
  });

  it('uses the given port, and fails clearly when it is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    try {
      await expect(start({ port: taken })).rejects.toMatchObject({ code: 'port-unavailable' });
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
    // The port is free again now, so it can be asked for by number.
    const session = await start({ port: taken });
    expect(session.port).toBe(taken);
  });
});

describe('static files', () => {
  it('lets the browser keep only assets/ and pdfjs/, and checks every other file again', async () => {
    await ws.write('web/llms.txt', 'synthetic');
    await mkdir(ws.path('web/pdfjs/cmaps'), { recursive: true });
    await ws.write('web/pdfjs/cmaps/Synthetic-H.bcmap', 'synthetic');
    const session = await start();
    // With a fixed --port the origin stays the same across CLI upgrades: an unhashed name must not
    // be served from an older build that the browser kept.
    const llms = await http(session.port, { path: '/llms.txt' });
    expect(llms.status).toBe(200);
    expect(llms.headers['cache-control']).toBe('no-cache');
    // The page may need these after the server has closed: the hashed build and the pdf.js data.
    for (const path of ['/assets/app.js', '/pdfjs/cmaps/Synthetic-H.bcmap']) {
      const reply = await http(session.port, { path });
      expect(reply.status, path).toBe(200);
      expect(reply.headers['cache-control'], path).toBe('private, max-age=86400');
    }
    expect((await http(session.port, { path: '/' })).headers['cache-control']).toBe('no-store');
    expect((await http(session.port, { path: '/some/route' })).headers['cache-control']).toBe('no-store');
  });

  it('serves the web app with content types and the security headers', async () => {
    const session = await start();
    const index = await http(session.port, {});
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.body.toString()).toBe(FIXTURE_INDEX_HTML);
    expect(index.headers['content-security-policy']).toContain("default-src 'self'");
    expect(index.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(index.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.headers['x-frame-options']).toBe('DENY');
    expect(index.headers['referrer-policy']).toBe('no-referrer');
    expect(index.headers['access-control-allow-origin']).toBeUndefined();
    expect(index.headers['cache-control']).toBe('no-store');

    const script = await http(session.port, { path: '/assets/app.js' });
    expect(script.status).toBe(200);
    // The page needs its own files again after the server has closed: the browser may keep them.
    expect(script.headers['cache-control']).toBe('private, max-age=86400');
    expect(script.headers['x-content-type-options']).toBe('nosniff');
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.body.toString()).toContain('fixture');

    const head = await http(session.port, { method: 'HEAD', path: '/assets/app.js' });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
  });

  it('falls back to index.html for unknown paths and never leaves the web dir', async () => {
    const session = await start();
    await symlink(ws.path('secret.txt'), ws.path('web/link.txt'));
    for (const path of ['/sign/123', '/missing.js', '/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt', '/link.txt']) {
      const reply = await http(session.port, { path });
      expect(reply.status, path).toBe(200);
      expect(reply.body.toString(), path).toBe(FIXTURE_INDEX_HTML);
    }
    expect((await http(session.port, { path: '/%00' })).status).toBe(400);
    expect((await http(session.port, { path: '/%zz' })).status).toBe(400);
    expect((await http(session.port, { method: 'POST', path: '/' })).status).toBe(405);
  });

  it('serves only the file types a web build needs: no source maps, dotfiles or _headers', async () => {
    await mkdir(ws.path('web/.well-known'), { recursive: true });
    await mkdir(ws.path('web/.cache'), { recursive: true });
    await writeFile(ws.path('web/assets/app.js.map'), '{"version":3,"sources":["private-source.ts"]}');
    await writeFile(ws.path('web/.env'), 'FIXTURE_SECRET=1');
    await writeFile(ws.path('web/.well-known/fixture.json'), '{"hidden":true}');
    await writeFile(ws.path('web/.cache/app.js'), 'console.log("hidden");');
    await writeFile(ws.path('web/_headers'), '/*\n  X-Fixture: yes\n');
    await writeFile(ws.path('web/assets/notes.md'), '# notes');
    await writeFile(ws.path('web/assets/data.json'), '{"shown":true}');
    await writeFile(ws.path('web/robots.txt'), 'User-agent: *');
    // An allowed name that is a link to a file that is not allowed is refused by its real name.
    await symlink(ws.path('web/assets/app.js.map'), ws.path('web/assets/alias.js'));
    const session = await start();

    for (const path of [
      '/assets/app.js.map',
      '/.env',
      '/.well-known/fixture.json',
      '/.cache/app.js',
      '/_headers',
      '/assets/notes.md',
      '/assets/alias.js',
      '/assets/%61pp.js.map',
    ]) {
      const reply = await http(session.port, { path });
      expect(reply.status, path).toBe(404);
      expect(reply.json(), path).toEqual({ error: 'Not found.', code: 'not-found' });
      expect(reply.body.toString(), path).not.toMatch(/private-source|FIXTURE_SECRET|hidden|X-Fixture|notes/);
    }
    // A dotfile that does not exist is not answered with the app either.
    expect((await http(session.port, { path: '/.missing' })).status).toBe(404);

    const json = await http(session.port, { path: '/assets/data.json' });
    expect(json.status).toBe(200);
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(json.body.toString()).toBe('{"shown":true}');
    const text = await http(session.port, { path: '/robots.txt' });
    expect(text.status).toBe(200);
    expect(text.headers['content-type']).toBe('text/plain; charset=utf-8');
    // The _headers file is still applied, although it is not served.
    expect(text.headers['x-fixture']).toBe('yes');
    // A path that does not exist still gets the app.
    expect((await http(session.port, { path: '/assets/absent.map' })).body.toString()).toBe(FIXTURE_INDEX_HTML);
  });

  it('takes the headers from a _headers file in the web dir, keeping the built-in ones it omits', async () => {
    await writeFile(
      ws.path('web/_headers'),
      "/*\n  Content-Security-Policy: default-src 'none'\n  X-Fixture: yes\n\n/assets/*\n  X-Assets-Only: yes\n",
    );
    const session = await start();
    const index = await http(session.port, {});
    expect(index.headers['content-security-policy']).toBe("default-src 'none'");
    expect(index.headers['x-fixture']).toBe('yes');
    expect(index.headers['x-assets-only']).toBeUndefined();
    expect(index.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('request checks', () => {
  it('rejects a missing or wrong token on every API path', async () => {
    const session = await start();
    const token = tokenOf(session);
    const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const [method, path] of [
      ['GET', '/api/packet'],
      ['POST', '/api/signed'],
      ['POST', '/api/declined'],
      ['POST', '/api/handed-off'],
      ['GET', '/api/unknown'],
    ] as const) {
      const attempts: Array<Record<string, string>> = [
        {},
        { Authorization: `Bearer ${wrong}` },
        { Authorization: token },
        // The nonce from the link is not a token.
        { Authorization: `Bearer ${nonceOf(session)}` },
        { Authorization: 'Bearer ' },
      ];
      for (const headers of attempts) {
        const reply = await http(session.port, { method, path, headers, body: method === 'POST' ? '{}' : '' });
        expect(reply.status, `${method} ${path}`).toBe(401);
        expect(reply.json().error).toContain('token');
        expect(reply.json().code).toBe('unauthorized');
        expect(reply.headers['cache-control']).toBe('no-store');
      }
    }
    // A token in the query string is not accepted either.
    expect((await http(session.port, { path: `/api/packet?session=${token}` })).status).toBe(401);
    expect(await isPending(session.result)).toBe(true);
  });

  it('rejects a Host header that is not its own loopback address', async () => {
    const session = await start();
    for (const host of ['attacker.example', `attacker.example:${session.port}`, '127.0.0.1', `127.0.0.1:${session.port + 1}`, `[::1]:${session.port}`]) {
      for (const path of ['/', '/api/packet']) {
        const reply = await http(session.port, { path, headers: { ...auth(session), Host: host } });
        expect(reply.status, `${host} ${path}`).toBe(403);
      }
    }
    const viaLocalhost = await http(session.port, { path: '/api/packet', headers: { ...auth(session), Host: `localhost:${session.port}` } });
    expect(viaLocalhost.status).toBe(200);
  });

  it('rejects a foreign Origin and sends no CORS headers', async () => {
    const session = await start();
    for (const origin of ['https://attacker.example', `http://attacker.example:${session.port}`, 'null', `https://127.0.0.1:${session.port}`, `http://localhost:${session.port}`]) {
      const reply = await http(session.port, { path: '/api/packet', headers: { ...auth(session), Origin: origin } });
      expect(reply.status, origin).toBe(403);
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
    const preflight = await http(session.port, {
      method: 'OPTIONS',
      path: '/api/packet',
      headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    const crossSite = await http(session.port, { path: '/api/packet', headers: { ...auth(session), 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSite.status).toBe(403);

    const own = await http(session.port, { path: '/api/packet', headers: { ...auth(session), Origin: session.origin, 'Sec-Fetch-Site': 'same-origin' } });
    expect(own.status).toBe(200);
    expect(own.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers wrong methods and unknown API paths with JSON errors', async () => {
    const session = await start();
    expect((await http(session.port, { method: 'POST', path: '/api/packet', headers: auth(session) })).status).toBe(405);
    expect((await http(session.port, { path: '/api/signed', headers: auth(session) })).status).toBe(405);
    const unknown = await http(session.port, { path: '/api/other', headers: auth(session) });
    expect(unknown.status).toBe(404);
    expect(unknown.headers['content-type']).toBe('application/json');
    expect(unknown.json()).toEqual({ error: 'Unknown API path.', code: 'not-found' });
    const wrongMethod = await http(session.port, { method: 'POST', path: '/api/packet', headers: auth(session) });
    expect(wrongMethod.json()).toEqual({ error: 'Use GET for this path.', code: 'method-not-allowed' });
  });
});

describe('nonce exchange', () => {
  it('gives the token for the nonce exactly once, and tells a second caller that the link was already opened', async () => {
    const session = await startUnopened();
    expect(session.opened()).toBe(false);
    const nonce = nonceOf(session);

    const first = await postNonce(session, nonce);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('application/json');
    expect(first.headers['cache-control']).toBe('no-store');
    const body = first.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual(['token']);
    const token = String(body['token']);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    // The token is a different secret from the nonce in the link.
    expect(token).not.toBe(nonce);
    expect(session.url).not.toContain(token);
    expect(session.opened()).toBe(true);

    const second = await postNonce(session, nonce);
    expect(second.status).toBe(401);
    expect(second.json().code).toBe('session-already-opened');
    expect(second.json().error).toContain('This signing link was already opened in another tab or by another program');
    expect(second.body.toString()).not.toContain(token);

    // The token works; the nonce does not work as a token.
    expect((await http(session.port, { path: '/api/packet', headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    const withNonce = await http(session.port, { path: '/api/packet', headers: { Authorization: `Bearer ${nonce}` } });
    expect(withNonce.status).toBe(401);
    expect(withNonce.json().code).toBe('unauthorized');
    expect(await isPending(session.result)).toBe(true);
  });

  it('refuses a wrong nonce without using up the real one', async () => {
    const session = await startUnopened();
    const nonce = nonceOf(session);
    const wrong = `${nonce.slice(0, -1)}${nonce.endsWith('A') ? 'B' : 'A'}`;
    for (const guess of [wrong, 'x', nonce.slice(0, -1), `${nonce}A`]) {
      const reply = await postNonce(session, guess);
      expect(reply.status, guess).toBe(401);
      expect(reply.json()).toEqual({ error: 'This signing link is not valid.', code: 'invalid-nonce' });
    }
    expect(session.opened()).toBe(false);
    // Before the exchange nothing is authorized, the nonce included.
    expect((await http(session.port, { path: '/api/packet', headers: { Authorization: `Bearer ${nonce}` } })).status).toBe(401);

    const token = await exchangeNonce(session.port, session.url);
    expect(session.opened()).toBe(true);
    expect((await http(session.port, { path: '/api/packet', headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it(`locks after ${MAX_BAD_NONCES} wrong nonces and ends an unopened session as cancelled at once`, async () => {
    expect(MAX_BAD_NONCES).toBe(20);
    const session = await startUnopened();
    for (let attempt = 1; attempt < MAX_BAD_NONCES; attempt++) {
      const reply = await postNonce(session, `wrong-${attempt}`);
      expect(reply.status, `attempt ${attempt}`).toBe(401);
      expect(reply.json().code).toBe('invalid-nonce');
    }
    const last = await postNonce(session, `wrong-${MAX_BAD_NONCES}`);
    expect(last.status).toBe(429);
    expect(last.json().code).toBe('session-locked');
    expect(last.json<Record<string, unknown>>()['token']).toBeUndefined();
    // No wait for the timeout: the result is there now, and the server is closed.
    expect(await session.result).toEqual({ status: 'cancelled', reason: 'locked' });
    expect(session.opened()).toBe(false);
    await expect(postNonce(session, nonceOf(session))).rejects.toThrow();
  });

  it('keeps an opened session when wrong nonces lock the link', async () => {
    const session = await startUnopened();
    const token = await exchangeNonce(session.port, session.url);
    for (let attempt = 1; attempt <= MAX_BAD_NONCES; attempt++) await postNonce(session, `wrong-${attempt}`);
    const right = await postNonce(session, nonceOf(session));
    expect(right.status).toBe(429);
    expect(right.json().code).toBe('session-locked');
    expect(await isPending(session.result)).toBe(true);
    expect((await http(session.port, { path: '/api/packet', headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('does not lock one attempt early', async () => {
    const session = await startUnopened();
    for (let attempt = 1; attempt < MAX_BAD_NONCES; attempt++) await postNonce(session, `wrong-${attempt}`);
    expect((await postNonce(session, nonceOf(session))).status).toBe(200);
  });

  it('applies the Host, Origin and Sec-Fetch-Site checks before looking at the nonce', async () => {
    const session = await startUnopened();
    const nonce = nonceOf(session);
    const refused: Array<Record<string, string>> = [
      { Host: 'attacker.example' },
      { Host: `attacker.example:${session.port}` },
      { Origin: 'https://attacker.example' },
      { Origin: 'null' },
      { Origin: `http://localhost:${session.port}` },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ];
    for (const headers of refused) {
      const reply = await postNonce(session, nonce, headers);
      expect(reply.status, JSON.stringify(headers)).toBe(403);
      expect(reply.json().code).toBe('forbidden');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
    // None of those used the nonce up.
    expect(session.opened()).toBe(false);
    const own = await postNonce(session, nonce, { Origin: session.origin, 'Sec-Fetch-Site': 'same-origin' });
    expect(own.status).toBe(200);
    expect(own.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a wrong method, content type or body with a JSON error, and none of them counts as a guess', async () => {
    const session = await startUnopened();
    const nonce = nonceOf(session);
    const get = await http(session.port, { path: '/api/session' });
    expect(get.status).toBe(405);
    expect(get.headers['allow']).toBe('POST');
    expect(get.json().code).toBe('method-not-allowed');
    // The nonce is not read from the query string.
    expect((await http(session.port, { path: `/api/session?nonce=${nonce}` })).status).toBe(405);

    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const reply = await http(session.port, { method: 'POST', path: '/api/session', headers: { 'Content-Type': contentType }, body: JSON.stringify({ nonce }) });
      expect(reply.status, contentType).toBe(415);
      expect(reply.json().code).toBe('unsupported-media-type');
    }
    const noType = await http(session.port, { method: 'POST', path: '/api/session', body: JSON.stringify({ nonce }) });
    expect(noType.status).toBe(415);

    for (const body of ['', '{ not json', '{}', '[]', 'null', JSON.stringify({ nonce: 7 }), JSON.stringify({ nonce: '' }), JSON.stringify({ nonce: [nonce] })]) {
      const reply = await http(session.port, { method: 'POST', path: '/api/session', headers: { 'Content-Type': 'application/json' }, body });
      expect(reply.status, body).toBe(400);
      expect(reply.json().code).toBe('bad-request');
    }
    const big = await postNonce(session, 'x'.repeat(8192));
    expect(big.status).toBe(413);
    expect(big.json().code).toBe('body-too-large');

    // More than MAX_BAD_NONCES malformed calls were made; the real nonce still works.
    for (let extra = 0; extra < MAX_BAD_NONCES; extra++) {
      await http(session.port, { method: 'POST', path: '/api/session', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }
    expect(session.opened()).toBe(false);
    expect((await postNonce(session, nonce)).status).toBe(200);
  });

  it('accepts a charset on the content type', async () => {
    const session = await startUnopened();
    const reply = await postNonce(session, nonceOf(session), { 'Content-Type': 'application/json; charset=utf-8' });
    expect(reply.status).toBe(200);
  });
});

describe('hand-off', () => {
  it('gives the packet to the browser and accepts the signed PDF once', async () => {
    const saved: Uint8Array[] = [];
    const session = await start({ onSigned: async (signed) => void saved.push(signed.pdf) });

    const packet = await http(session.port, { path: '/api/packet', headers: auth(session) });
    expect(packet.status).toBe(200);
    expect(packet.headers['content-type']).toBe('application/json');
    expect(packet.headers['cache-control']).toBe('no-store');
    expect(packet.body.toString()).toBe(encodePacket(await createPacket(pdf, await requestFor(pdf))));

    const signed = await signAsHuman(packet.body.toString());
    const reply = await http(session.port, { method: 'POST', path: '/api/signed', headers: signedHeaders(session, signed.sha256), body: signed.pdf });
    expect(reply.status).toBe(204);
    expect(reply.headers['cache-control']).toBe('no-store');

    const result = await session.result;
    expect(result.status).toBe('signed');
    if (result.status !== 'signed') return;
    expect(result.sha256).toBe(signed.sha256);
    expect(await sha256Hex(result.pdf)).toBe(signed.sha256);
    expect(result.audit.document.originalSha256).toBe(await sha256Hex(pdf));
    expect(result.audit.signer.name).toBe('Ada Example');
    expect(saved).toHaveLength(1);
    // One result, then the server is gone.
    expect(await isClosed(session.port)).toBe(true);
  });

  it('rejects bad uploads with a JSON error and keeps waiting', async () => {
    const session = await start();
    const packetText = encodePacket(await createPacket(pdf, await requestFor(pdf)));
    const signed = await signAsHuman(packetText);
    const post = (headers: Record<string, string>, body: Uint8Array | string) =>
      http(session.port, { method: 'POST', path: '/api/signed', headers, body });

    // Hash header that does not match the body.
    const mismatch = await post(signedHeaders(session, '0'.repeat(64)), signed.pdf);
    expect(mismatch.status).toBe(400);
    expect(mismatch.json().error).toContain('X-Sign-Pdf-Sha256');
    expect(mismatch.json().code).toBe('bad-request');

    // Missing hash header, wrong content type, empty body.
    expect((await post({ ...auth(session), 'Content-Type': 'application/pdf' }, signed.pdf)).status).toBe(400);
    expect((await post({ ...signedHeaders(session, signed.sha256), 'Content-Type': 'application/json' }, signed.pdf)).status).toBe(415);
    expect((await post(signedHeaders(session, await sha256Hex(new Uint8Array())), '')).status).toBe(400);

    // Not a PDF at all.
    const junk = new TextEncoder().encode('not a pdf');
    const notPdf = await post(signedHeaders(session, await sha256Hex(junk)), junk);
    expect(notPdf.status).toBe(422);
    expect(notPdf.json().code).toBe('not-a-pdf');

    // Another PDF that was never signed: no audit record.
    const plain = await fixturePdf({ title: 'A different agreement' });
    const unsigned = await post(signedHeaders(session, await sha256Hex(plain)), plain);
    expect(unsigned.status).toBe(422);
    expect(unsigned.json().code).toBe('no-audit-record');
    expect(unsigned.json().error).toContain('audit record');

    // A properly signed PDF of another document.
    const otherPdf = await fixturePdf({ title: 'A different agreement' });
    const other = await signAsHuman(encodePacket(await createPacket(otherPdf, await requestFor(otherPdf))));
    const wrongDocument = await post(signedHeaders(session, other.sha256), other.pdf);
    expect(wrongDocument.status).toBe(422);
    expect(wrongDocument.json().error).toContain("session's document");
    expect(wrongDocument.json().code).toBe('wrong-document');

    // The right document, signed against a different request.
    const otherRequest = await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 300, 300, 120, 30) }]);
    const swapped = await signAsHuman(encodePacket(await createPacket(pdf, otherRequest)));
    const wrongRequest = await post(signedHeaders(session, swapped.sha256), swapped.pdf);
    expect(wrongRequest.status).toBe(422);
    expect(wrongRequest.json().error).toContain("session's sign request");
    expect(wrongRequest.json().code).toBe('wrong-request');

    expect(await isPending(session.result)).toBe(true);

    // After all that, the human can still succeed.
    expect((await post(signedHeaders(session, signed.sha256), signed.pdf)).status).toBe(204);
    expect((await session.result).status).toBe('signed');
  });

  it('refuses forged uploads on which nothing was signed, and keeps waiting', async () => {
    const session = await start();
    const packetText = encodePacket(await createPacket(pdf, await requestFor(pdf)));
    const signed = await signAsHuman(packetText);
    const post = async (body: Uint8Array) =>
      http(session.port, { method: 'POST', path: '/api/signed', headers: signedHeaders(session, await sha256Hex(body)), body });

    // The genuine audit record of a properly signed copy: it names this document and this request.
    const genuine = (await verifySignedPdf(signed.pdf)).audit;
    if (!genuine) throw new Error('the signed fixture has no audit record');
    expect(genuine.fields.map((field) => field.id)).toEqual(['sig', 'name']);
    /** The ORIGINAL pdf, nothing drawn on it, with an audit record attached the way core attaches it. */
    const forge = async (edit: (audit: AuditRecord) => void = () => undefined): Promise<Uint8Array> => {
      const audit = structuredClone(genuine);
      edit(audit);
      const doc = await PDFDocument.load(pdf, { updateMetadata: false });
      await doc.attach(new TextEncoder().encode(JSON.stringify(audit, null, 2)), AUDIT_ATTACHMENT_NAME, {
        mimeType: 'application/json',
        description: 'sign-pdf audit record',
      });
      return doc.save({ updateFieldAppearances: false });
    };

    // (i) The original bytes, unchanged.
    const unchanged = await post(pdf);
    expect(unchanged.status).toBe(422);
    expect(unchanged.json().code).toBe('unchanged-document');
    expect(await isPending(session.result)).toBe(true);

    // (ii) A matching audit record, but no signature was drawn on the page.
    const recordOnly = await forge();
    // The forgery is good enough to read back as a signed document: only the page check stops it.
    expect(await verifySignedPdf(recordOnly)).toMatchObject({ hasAuditRecord: true, audit: { requestSha256: genuine.requestSha256 } });
    const notDrawn = await post(recordOnly);
    expect(notDrawn.status).toBe(422);
    expect(notDrawn.json().code).toBe('unchanged-page');
    expect(notDrawn.json().error).toContain('Page 1');
    expect(await isPending(session.result)).toBe(true);

    // (iii) The record admits that the signature field carries no signature.
    for (const key of ['signatureMethod', 'signatureSha256'] as const) {
      const reply = await post(
        await forge((audit) => {
          const entry = audit.fields.find((field) => field.id === 'sig');
          if (!entry) throw new Error('no sig entry');
          delete entry[key];
        }),
      );
      expect(reply.status, key).toBe(422);
      expect(reply.json().code, key).toBe('missing-signature');
      expect(reply.json().error).toContain('"sig"');
    }
    const neither = await post(
      await forge((audit) => {
        const entry = audit.fields.find((field) => field.id === 'sig');
        delete entry?.signatureMethod;
        delete entry?.signatureSha256;
      }),
    );
    expect(neither.status).toBe(422);
    expect(neither.json().code).toBe('missing-signature');
    expect(await isPending(session.result)).toBe(true);

    // (iv) The record leaves the signature field out.
    const withoutEntry = await post(
      await forge((audit) => {
        audit.fields = audit.fields.filter((field) => field.id !== 'sig');
      }),
    );
    expect(withoutEntry.status).toBe(422);
    expect(withoutEntry.json().code).toBe('incomplete-audit-record');
    expect(withoutEntry.json().error).toContain('"sig"');
    expect(await isPending(session.result)).toBe(true);

    // A genuine signed PDF is still accepted afterwards.
    expect((await post(signed.pdf)).status).toBe(204);
    const result = await session.result;
    expect(result.status).toBe('signed');
    if (result.status === 'signed') expect(result.sha256).toBe(signed.sha256);
  });

  it('with several signers, needs one signing pass per signer in request order', async () => {
    const twoSigners = await requestFor(
      pdf,
      [
        { id: 'sigA', type: 'signature', assignee: 'human', signerId: 'a', placement: rect(1, 72, 500, 180, 36) },
        { id: 'sigB', type: 'signature', assignee: 'human', signerId: 'b', placement: rect(1, 300, 500, 180, 36) },
      ],
      { signers: [{ id: 'a', name: 'Signer One' }, { id: 'b' }] },
    );
    const packet = await createPacket(pdf, twoSigners);
    const session = await start({ packet });
    const signed = await signAsHuman(encodePacket(packet));
    const genuine = (await verifySignedPdf(signed.pdf)).audit;
    if (!genuine?.passes) throw new Error('the signed fixture has no passes');
    expect(genuine.passes.map((pass) => pass.signerId)).toEqual(['a', 'b']);

    const forge = async (edit: (audit: AuditRecord) => void): Promise<Uint8Array> => {
      const audit = structuredClone(genuine);
      edit(audit);
      const doc = await PDFDocument.load(signed.pdf, { updateMetadata: false });
      await doc.attach(new TextEncoder().encode(JSON.stringify(audit)), AUDIT_ATTACHMENT_NAME, { mimeType: 'application/json' });
      return doc.save({ updateFieldAppearances: false });
    };
    const post = async (body: Uint8Array) =>
      http(session.port, { method: 'POST', path: '/api/signed', headers: signedHeaders(session, await sha256Hex(body)), body });

    const edits: [string, (audit: AuditRecord) => void, string][] = [
      ['no passes', (audit) => delete audit.passes, '"a"'],
      ['a missing pass', (audit) => audit.passes?.pop(), '"b"'],
      ['the wrong order', (audit) => audit.passes?.reverse(), '"a"'],
      ['an extra pass', (audit) => audit.passes?.push(structuredClone(audit.passes[1]!)), 'more signing passes'],
      ['a pass listing another signer’s field', (audit) => audit.passes?.[0]?.fieldIds.push('sigB'), 'exactly the fields that signer owns'],
      [
        'a field given to the other signer',
        (audit) => Object.assign(audit.fields.find((field) => field.id === 'sigA') ?? {}, { signerId: 'b' }),
        'gives the field "sigA" to the wrong signer',
      ],
      [
        'an agent-field signer the request does not have',
        (audit) => audit.fields.push({ ...audit.fields[0]!, id: 'extra', signerId: 'z' }),
        'do not hold together',
      ],
      ['a broken chain', (audit) => { if (audit.passes?.[0]) audit.passes[0].signer.name = 'Someone Else'; }, 'do not hold together'],
    ];
    for (const [name, edit, message] of edits) {
      const reply = await post(await forge(edit));
      expect(reply.status, name).toBe(422);
      expect(reply.json().code, name).toBe('missing-signer-pass');
      expect(reply.json().error, name).toContain(message);
    }
    expect(await isPending(session.result)).toBe(true);

    expect((await post(signed.pdf)).status).toBe(204);
    const result = await session.result;
    expect(result.status).toBe('signed');
    if (result.status !== 'signed') return;
    expect(summarizeAudit(result.audit).signers).toEqual([
      { id: 'a', name: 'Signer 1', signedAt: '2031-03-04T10:00:00.000Z' },
      { id: 'b', name: 'Signer 2', signedAt: '2031-03-04T10:00:00.000Z' },
    ]);
    expect(summarizeAudit(genuine)).toMatchObject({ signerName: 'Signer 2' });
  });

  it('refuses an oversize body cleanly and keeps waiting', async () => {
    const packetText = encodePacket(await createPacket(pdf, await requestFor(pdf)));
    const signed = await signAsHuman(packetText);
    const session = await start({ maxBodyBytes: signed.pdf.length });

    const big = new Uint8Array(signed.pdf.length + 1);
    const declared = await http(session.port, { method: 'POST', path: '/api/signed', headers: signedHeaders(session, await sha256Hex(big)), body: big });
    expect(declared.status).toBe(413);
    expect(declared.json().error).toContain('larger than the limit');
    expect(declared.json().code).toBe('body-too-large');

    // Chunked upload: no Content-Length to check in advance.
    const huge = new Uint8Array(signed.pdf.length * 3);
    const chunked = await http(session.port, {
      method: 'POST',
      path: '/api/signed',
      headers: { ...signedHeaders(session, await sha256Hex(huge)), 'Transfer-Encoding': 'chunked' },
      body: huge,
    });
    expect(chunked.status).toBe(413);

    expect(await isPending(session.result)).toBe(true);
    const ok = await http(session.port, { method: 'POST', path: '/api/signed', headers: signedHeaders(session, signed.sha256), body: signed.pdf });
    expect(ok.status).toBe(204);
  });

  it('reports a save failure to the browser and keeps waiting', async () => {
    let attempts = 0;
    const session = await start({
      onSigned: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      },
    });
    const signed = await signAsHuman(encodePacket(await createPacket(pdf, await requestFor(pdf))));
    const post = () => http(session.port, { method: 'POST', path: '/api/signed', headers: signedHeaders(session, signed.sha256), body: signed.pdf });
    const failed = await post();
    expect(failed.status).toBe(500);
    expect(failed.json().error).toContain('disk full');
    expect(failed.json().code).toBe('save-failed');
    expect(await isPending(session.result)).toBe(true);
    expect((await post()).status).toBe(204);
    expect((await session.result).status).toBe('signed');
  });

  it('finishes as declined, with the reason', async () => {
    const session = await start();
    const bad = await http(session.port, { method: 'POST', path: '/api/declined', headers: auth(session), body: '{ not json' });
    expect(bad.status).toBe(400);
    expect(bad.json().code).toBe('bad-request');
    const reply = await http(session.port, {
      method: 'POST',
      path: '/api/declined',
      headers: { ...auth(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'The party name is wrong.' }),
    });
    expect(reply.status).toBe(204);
    expect(await session.result).toEqual({ status: 'declined', reason: 'The party name is wrong.' });
    expect(await isClosed(session.port)).toBe(true);
  });

  it('accepts a decline without a reason', async () => {
    const session = await start();
    expect((await http(session.port, { method: 'POST', path: '/api/declined', headers: auth(session) })).status).toBe(204);
    expect(await session.result).toEqual({ status: 'declined' });
  });

  it('finishes as handed_off when a signer who has a next signer hands off, and takes nothing else', async () => {
    const threeSigners = await requestFor(
      pdf,
      [
        { id: 'sigA', type: 'signature', assignee: 'human', signerId: 'a', placement: rect(1, 72, 500, 180, 36) },
        { id: 'sigB', type: 'signature', assignee: 'human', signerId: 'b', placement: rect(1, 300, 500, 180, 36) },
        { id: 'sigC', type: 'signature', assignee: 'human', signerId: 'c', placement: rect(1, 72, 600, 180, 36) },
      ],
      { signers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    );
    const session = await start({ packet: await createPacket(pdf, threeSigners) });
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      http(session.port, {
        method: 'POST',
        path: '/api/handed-off',
        headers: { ...auth(session), 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    // A foreign page cannot end the session, even with the token.
    expect((await post({ signerId: 'a' }, { Origin: 'http://evil.example' })).status).toBe(403);
    // Only JSON, and only a signerId: no signature or PDF rides along.
    expect((await post({ signerId: 'a' }, { 'Content-Type': 'text/plain' })).json().code).toBe('unsupported-media-type');
    for (const body of ['{ not json', {}, { signerId: 7 }, { signerId: '' }, { signerId: 'a', signatures: { sigA: 'iVBORw0KGgo=' } }, ['a']]) {
      const reply = await post(body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.json().code).toBe('bad-request');
    }
    // An unknown signer, and the last signer (who has nobody to hand off to), are refused.
    for (const signerId of ['z', 'c']) {
      const reply = await post({ signerId });
      expect(reply.status, signerId).toBe(422);
      expect(reply.json().code).toBe('wrong-signer');
    }
    expect(await isPending(session.result)).toBe(true);

    expect((await post({ signerId: 'b' })).status).toBe(204);
    expect(await session.result).toEqual({ status: 'handed_off', signed: ['a', 'b'], pending: ['c'] });
    expect(await isClosed(session.port)).toBe(true);
  });

  it('refuses a hand-off for a request without signers, and keeps waiting', async () => {
    const session = await start();
    const reply = await http(session.port, {
      method: 'POST',
      path: '/api/handed-off',
      headers: { ...auth(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ signerId: 'a' }),
    });
    expect(reply.status).toBe(422);
    expect(reply.json().code).toBe('wrong-signer');
    expect(await isPending(session.result)).toBe(true);
  });

  it('times out and closes the server', async () => {
    const session = await start({ timeoutMs: 150 });
    expect(await session.result).toEqual({ status: 'timeout' });
    expect(await isClosed(session.port)).toBe(true);
  });

  it('closes on request, and close is safe to repeat', async () => {
    const session = await start();
    await session.close();
    expect(await session.result).toEqual({ status: 'cancelled' });
    expect(await isClosed(session.port)).toBe(true);
    await session.close();
  });

  it('rejects unusable timeouts, ports and web directories before listening', async () => {
    await expect(start({ timeoutMs: 0 })).rejects.toMatchObject({ code: 'usage' });
    await expect(start({ port: 70_000 })).rejects.toMatchObject({ code: 'usage' });
    await expect(start({ webDir: ws.path('absent') })).rejects.toMatchObject({ code: 'web-dir-missing' });
  });
});

describe('sign-pdf request', () => {
  let pdfPath: string;
  let requestPath: string;

  beforeEach(async () => {
    pdfPath = await ws.write('fixture.pdf', pdf);
    requestPath = await ws.write('request.json', JSON.stringify(await requestFor(pdf)));
  });

  /**
   * A fake browser: called with the link instead of a real one being opened.
   * Like the sign view, it first exchanges the nonce in the link for the token.
   */
  function browser(act: (port: number, token: string) => Promise<void>) {
    const state: { port?: number; link?: string; done?: Promise<void> } = {};
    const openBrowser = (url: string) => {
      const port = Number(new URL(url).port);
      state.port = port;
      state.link = url;
      state.done = exchangeNonce(port, url).then((token) => act(port, token));
      // A failure is reported where the test awaits `state.done`, not as an unhandled rejection.
      state.done.catch(() => undefined);
    };
    return { state, openBrowser };
  }

  const sign = async (port: number, token: string) => {
    const headers = { Authorization: `Bearer ${token}` };
    const packet = await http(port, { path: '/api/packet', headers });
    const signed = await signAsHuman(packet.body.toString());
    const reply = await http(port, {
      method: 'POST',
      path: '/api/signed',
      headers: { ...headers, 'Content-Type': 'application/pdf', 'X-Sign-Pdf-Sha256': signed.sha256 },
      body: signed.pdf,
    });
    expect(reply.status).toBe(204);
  };

  const LINK = /http:\/\/127\.0\.0\.1:\d+\/#session=[A-Za-z0-9_-]+/;
  const errorLines = (stderr: string): string[] => stderr.split('\n').filter((line) => line.startsWith('error ['));

  it('writes and reports the signed PDF, exit 0', async () => {
    const { state, openBrowser } = browser(sign);
    const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '--json'], { openBrowser });
    await state.done;
    expect(result.code).toBe(0);
    const out = result.json<{ ok: boolean; status: string; path: string; sha256: string; integrity: string; auditNotice: string; problems: string[]; audit: { signerName: string; signedFieldIds: string[] } }>();
    expect(Object.keys(out)).toEqual(['ok', 'status', 'path', 'sha256', 'integrity', 'auditNotice', 'audit', 'problems']);
    expect(out).toMatchObject({ ok: true, status: 'signed', path: ws.path('fixture-signed.pdf'), integrity: 'unverified', problems: [] });
    expect(out.auditNotice).toContain('unauthenticated');
    expect(out.audit).toMatchObject({ signerName: 'Ada Example', signedFieldIds: ['sig'] });
    expect(out.audit).not.toHaveProperty('signers');

    const written = new Uint8Array(await readFile(out.path));
    expect(await sha256Hex(written)).toBe(out.sha256);
    const verified = await runCli(['verify', out.path, '--json']);
    expect(verified.json()).toMatchObject({ ok: true, hasAuditRecord: true, audit: { document: { originalSha256: await sha256Hex(pdf) } } });

    // The browser was opened with the link; the output shows only the bare origin.
    expect(state.link).toMatch(LINK);
    expect(result.stderr).toContain(`in your browser at http://127.0.0.1:${state.port}.`);
    expect(result.stdout).not.toContain('#session=');
    expect(result.stderr).not.toContain('#session=');
    expect(errorLines(result.stderr)).toEqual([]);
    expect(await isClosed(state.port ?? 0)).toBe(true);
  });

  it('prints the bare origin on stdout by default, and the link nowhere', async () => {
    const { state, openBrowser } = browser(sign);
    const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir], { openBrowser });
    await state.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`The document is open in your browser at http://127.0.0.1:${state.port}. Review and sign it there.`);
    expect(result.stdout).toContain(`Signed PDF written to ${ws.path('fixture-signed.pdf')}`);
    expect(result.stdout).toContain('Status: signed. Integrity: unverified.');
    expect(result.stdout).not.toContain('#session=');
    expect(result.stdout).not.toContain(new URL(state.link ?? '').hash.replace('#session=', ''));
    expect(result.stderr).toBe('');
  });

  for (const json of [false, true]) {
    it(`with --no-open prints the link and a warning on stderr only${json ? ' (--json)' : ''}`, async () => {
      let opened = 0;
      let port = 0;
      let done: Promise<void> | undefined;
      const out = ws.path('out/done.pdf');
      const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '--no-open', '-o', out, ...(json ? ['--json'] : [])], {
        openBrowser: () => void (opened += 1),
        // The human reads the link on stderr and opens it.
        stderr: (text) => {
          const link = LINK.exec(text)?.[0];
          if (link === undefined) return;
          port = Number(new URL(link).port);
          done = signInBrowser(link).then((reply) => expect(reply.status).toBe(204));
          done.catch(() => undefined);
        },
      });
      await done;
      expect(result.code).toBe(0);
      expect(opened).toBe(0);
      expect(port).toBeGreaterThan(0);

      const lines = result.stderr.split('\n');
      const at = lines.findIndex((line) => LINK.test(line));
      expect(lines[at - 1]).toBe('Open this link in a browser on this computer to review and sign:');
      expect(lines[at]).toMatch(new RegExp(`^  ${LINK.source}$`));
      expect(lines[at + 1]).toMatch(/^Warning: .*Do not share it\.$/);
      expect(result.stderr.match(/#session=/g)).toHaveLength(1);
      expect(result.stderr).not.toContain('could not be opened');

      expect(result.stdout).not.toContain('#session=');
      expect(result.stdout).not.toMatch(/\bvalid\b|\bverified\b/i);
      if (json) {
        expect(result.json()).toMatchObject({ ok: true, status: 'signed', path: out, integrity: 'unverified' });
        expect(JSON.stringify(result.json())).not.toContain('session=');
      } else {
        expect(result.stdout).toContain(`Signed PDF written to ${out}`);
        expect(result.stdout).toContain('unauthenticated claim');
      }
      expect((await readFile(out)).subarray(0, 5).toString()).toBe('%PDF-');
      expect(await isClosed(port)).toBe(true);
    });
  }

  it('when the browser cannot be opened, prints the link and the warning on stderr only', async () => {
    let port = 0;
    let done: Promise<void> | undefined;
    const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '--json'], {
      openBrowser: () => {
        throw new Error('simulated: no browser on this machine');
      },
      stderr: (text) => {
        const link = LINK.exec(text)?.[0];
        if (link === undefined) return;
        port = Number(new URL(link).port);
        done = signInBrowser(link).then((reply) => expect(reply.status).toBe(204));
        done.catch(() => undefined);
      },
    });
    await done;
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(new RegExp(`The browser could not be opened\\. Open this link in a browser on this computer to review and sign:\\n  ${LINK.source}\\nWarning: `));
    expect(result.stderr).not.toContain('is open in your browser');
    expect(result.stdout).not.toContain('#session=');
    expect(result.json()).toMatchObject({ ok: true, status: 'signed', path: ws.path('fixture-signed.pdf') });
    expect(await isClosed(port)).toBe(true);
  });

  it('the default opener refuses while SIGN_PDF_NO_OPEN is set, so no browser is reported as opened', async () => {
    expect(process.env['SIGN_PDF_NO_OPEN']).toBeTruthy();
    await expect(openInDefaultBrowser('http://127.0.0.1:9/#session=fixture')).rejects.toThrow('SIGN_PDF_NO_OPEN');
    // startSignRequest without an opener falls back to the default one, which refuses.
    const pending = await startSignRequest({ pdfPath, request: await requestFor(pdf), webDir, timeoutSeconds: 20 });
    try {
      expect(pending.browserOpened).toBe(false);
      expect(pending.link).toMatch(LINK);
      expect(pending.origin).toBe(new URL(pending.link).origin);
    } finally {
      await pending.cancel();
    }
    expect(await pending.outcome).toEqual({ status: 'cancelled' });
    expect(await isClosed(Number(new URL(pending.origin).port))).toBe(true);
  });

  it('exits 2 when the human declines', async () => {
    const { state, openBrowser } = browser(async (port, token) => {
      await http(port, { method: 'POST', path: '/api/declined', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ reason: 'Wrong date.' }) });
    });
    const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '--json'], { openBrowser });
    await state.done;
    expect(result.code).toBe(2);
    expect(result.json()).toEqual({
      ok: false,
      error: { code: 'declined', message: 'The human declined to sign.' },
      status: 'declined',
      reason: 'Wrong date.',
    });
    expect(errorLines(result.stderr)).toEqual(['error [declined]: The human declined to sign.']);
    expect(result.stdout).not.toContain('#session=');
    await expect(readFile(ws.path('fixture-signed.pdf'))).rejects.toThrow();
    expect(await isClosed(state.port ?? 0)).toBe(true);

    const text = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir], { openBrowser });
    expect(text.code).toBe(2);
    expect(text.stdout).toContain('The human declined to sign. Reason given: "Wrong date."');
    expect(text.stderr).toBe('error [declined]: The human declined to sign.\n');
  });

  it('exits 4 when a signer hands off to another device, lists who still signs, and writes no file', async () => {
    const twoSigners = await requestFor(
      pdf,
      [
        { id: 'sigA', type: 'signature', assignee: 'human', signerId: 'a', placement: rect(1, 72, 500, 180, 36) },
        { id: 'sigB', type: 'signature', assignee: 'human', signerId: 'b', placement: rect(1, 300, 500, 180, 36) },
      ],
      { signers: [{ id: 'a' }, { id: 'b', name: 'Signer Two' }] },
    );
    const twoPath = await ws.write('two.json', JSON.stringify(twoSigners));
    const { state, openBrowser } = browser(async (port, token) => {
      const reply = await http(port, {
        method: 'POST',
        path: '/api/handed-off',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerId: 'a' }),
      });
      expect(reply.status).toBe(204);
    });
    const result = await runCli(['request', pdfPath, twoPath, '--web-dir', webDir, '--json'], { openBrowser });
    await state.done;
    expect(result.code).toBe(4);
    expect(result.json()).toEqual({ ok: true, status: 'handed_off', signed: ['a'], pending: ['b'] });
    await expect(readFile(ws.path('fixture-signed.pdf'))).rejects.toThrow();
    expect(await isClosed(state.port ?? 0)).toBe(true);

    const text = await runCli(['request', pdfPath, twoPath, '--web-dir', webDir], { openBrowser });
    expect(text.code).toBe(4);
    expect(text.stdout).toContain('still to sign: b.');
    expect(text.stdout).toContain('the final signed PDF arrives by other means');
    expect(text.stderr).toBe('');
  });

  it('exits 3 on timeout', async () => {
    const { state, openBrowser } = browser(async () => undefined);
    const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '--timeout', '0.2', '--json'], { openBrowser });
    await state.done;
    expect(result.code).toBe(3);
    const out = result.json<{ error: { message: string; hint: string } }>();
    expect(out).toEqual({
      ok: false,
      error: { code: 'timeout', message: 'Timed out waiting for the signature.', hint: expect.stringContaining('--timeout') as unknown },
      status: 'timeout',
    });
    expect(errorLines(result.stderr)).toEqual(['error [timeout]: Timed out waiting for the signature.']);
    expect(await isClosed(state.port ?? 0)).toBe(true);
  });

  it('closes the server and exits 1 when interrupted', async () => {
    for (const json of [false, true]) {
      const abort = new AbortController();
      const { state, openBrowser } = browser(async () => abort.abort());
      const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, ...(json ? ['--json'] : [])], { openBrowser, signal: abort.signal });
      await state.done;
      expect(result.code).toBe(1);
      expect(errorLines(result.stderr)).toEqual(['error [cancelled]: Cancelled before a signature arrived.']);
      if (json) expect(result.json()).toEqual({ ok: false, error: { code: 'cancelled', message: 'Cancelled before a signature arrived.' }, status: 'cancelled' });
      expect(await isClosed(state.port ?? 0)).toBe(true);
    }
  });

  it('never overwrites an existing output file without --force', async () => {
    const existing = await ws.write('fixture-signed.pdf', 'keep me');
    let opened = 0;
    const refused = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir], { openBrowser: () => void (opened += 1) });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('error [file-exists]');
    expect(opened).toBe(0);
    expect(await readFile(existing, 'utf8')).toBe('keep me');

    const { state, openBrowser } = browser(sign);
    const forced = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '--force'], { openBrowser });
    await state.done;
    expect(forced.code).toBe(0);
    expect((await readFile(existing)).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await readdir(ws.dir)).sort()).toEqual(['fixture-signed.pdf', 'fixture.pdf', 'request.json', 'secret.txt', 'web']);
  });

  it('never loses a signature: an output file that appears during the session sends the PDF to the next free name', async () => {
    const planned = ws.path('fixture-signed.pdf');
    const { state, openBrowser } = browser(async (port, token) => {
      // Another program takes the name after the session started and before the human signs.
      await writeFile(planned, 'made by another program');
      await sign(port, token);
    });
    const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '--json'], { openBrowser });
    await state.done;
    expect(result.code).toBe(0);
    const out = result.json<{ ok: boolean; status: string; path: string; sha256: string }>();
    expect(out).toMatchObject({ ok: true, status: 'signed', path: ws.path('fixture-signed-2.pdf') });
    expect(await readFile(planned, 'utf8')).toBe('made by another program');
    expect(await sha256Hex(new Uint8Array(await readFile(out.path)))).toBe(out.sha256);
    expect((await readdir(ws.dir)).sort()).toEqual(['fixture-signed-2.pdf', 'fixture-signed.pdf', 'fixture.pdf', 'request.json', 'secret.txt', 'web']);

    // Text mode names the real path too.
    const again = browser(sign);
    const text = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '-o', ws.path('other.pdf')], {
      openBrowser: (url) => {
        void writeFile(ws.path('other.pdf'), 'taken').then(() => again.openBrowser(url));
      },
    });
    await again.state.done;
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`Signed PDF written to ${ws.path('other-2.pdf')}`);
    expect(await readFile(ws.path('other.pdf'), 'utf8')).toBe('taken');
  });

  it('never loses a signature: a save that cannot succeed is reported to the browser, and a later upload succeeds', async () => {
    const out = ws.path('out/done.pdf');
    const pending = await startSignRequest({ pdfPath, request: await requestFor(pdf), outPath: out, webDir, open: false, timeoutSeconds: 20 });
    const port = Number(new URL(pending.origin).port);
    try {
      expect(pending.browserOpened).toBe(false);
      expect(pending.outPath).toBe(out);
      const headers = { Authorization: `Bearer ${await exchangeNonce(port, pending.link)}` };
      const signed = await signAsHuman((await http(port, { path: '/api/packet', headers })).body.toString());
      const post = () =>
        http(port, {
          method: 'POST',
          path: '/api/signed',
          headers: { ...headers, 'Content-Type': 'application/pdf', 'X-Sign-Pdf-Sha256': signed.sha256 },
          body: signed.pdf,
        });

      // The output directory's name is taken by a file: nothing can be written there, under any numbered name.
      await writeFile(ws.path('out'), 'a file where the directory must be');
      for (let attempt = 0; attempt < 2; attempt++) {
        const failed = await post();
        expect(failed.status).toBe(500);
        expect(failed.json().code).toBe('save-failed');
        expect(failed.json().error).toContain('could not be saved');
        expect(await isPending(pending.outcome)).toBe(true);
      }
      expect(await readFile(ws.path('out'), 'utf8')).toBe('a file where the directory must be');

      // The human fixes the cause and sends the same document again.
      await rm(ws.path('out'));
      expect((await post()).status).toBe(204);
      const outcome = await pending.outcome;
      expect(outcome).toMatchObject({ status: 'signed', path: out, sha256: signed.sha256, integrity: 'unverified' });
      expect(await sha256Hex(new Uint8Array(await readFile(out)))).toBe(signed.sha256);
      expect(await readdir(ws.path('out'))).toEqual(['done.pdf']);
    } finally {
      await pending.cancel();
    }
    expect(await isClosed(port)).toBe(true);
  });

  it('never loses a signature: a document that could not be saved is saved when the session ends, if it can be', async () => {
    const out = ws.path('out/done.pdf');
    const pending = await startSignRequest({ pdfPath, request: await requestFor(pdf), outPath: out, webDir, open: false, timeoutSeconds: 20 });
    const port = Number(new URL(pending.origin).port);
    try {
      const headers = { Authorization: `Bearer ${await exchangeNonce(port, pending.link)}` };
      const signed = await signAsHuman((await http(port, { path: '/api/packet', headers })).body.toString());
      await writeFile(ws.path('out'), 'in the way');
      const failed = await http(port, {
        method: 'POST',
        path: '/api/signed',
        headers: { ...headers, 'Content-Type': 'application/pdf', 'X-Sign-Pdf-Sha256': signed.sha256 },
        body: signed.pdf,
      });
      expect(failed.status).toBe(500);
      // The browser goes away; the cause is fixed; the session is then cancelled.
      await rm(ws.path('out'));
      await pending.cancel();
      expect(await pending.outcome).toMatchObject({ status: 'signed', path: out, sha256: signed.sha256 });
      expect(await sha256Hex(new Uint8Array(await readFile(out)))).toBe(signed.sha256);
    } finally {
      await pending.cancel();
    }
    expect(await isClosed(port)).toBe(true);
  });

  it('with ifExists next-free plans the next free name at the start; the output is never one of the inputs', async () => {
    await ws.write('fixture-signed.pdf', 'keep me');
    await ws.write('fixture-signed-2.pdf', 'keep me too');
    const pending = await startSignRequest({ pdfPath, request: await requestFor(pdf), webDir, open: false, ifExists: 'next-free', timeoutSeconds: 20 });
    try {
      expect(pending.outPath).toBe(ws.path('fixture-signed-3.pdf'));
      expect((await signInBrowser(pending.link)).status).toBe(204);
      expect(await pending.outcome).toMatchObject({ status: 'signed', path: ws.path('fixture-signed-3.pdf') });
    } finally {
      await pending.cancel();
    }
    expect(await readFile(ws.path('fixture-signed.pdf'), 'utf8')).toBe('keep me');
    expect(await readFile(ws.path('fixture-signed-2.pdf'), 'utf8')).toBe('keep me too');
    expect(((await stat(ws.path('fixture-signed-3.pdf'))).mode & 0o777) === 0o600 || process.platform === 'win32').toBe(true);

    const request = await requestFor(pdf);
    for (const ifExists of ['fail', 'next-free'] as const) {
      for (const force of [false, true]) {
        await expect(
          startSignRequest({ pdfPath, request, webDir, open: false, outPath: requestPath, inputPaths: [requestPath], ifExists, force }),
        ).rejects.toMatchObject({ code: 'output-is-input' });
        await expect(startSignRequest({ pdfPath, request, webDir, open: false, outPath: pdfPath, ifExists, force })).rejects.toMatchObject({
          code: 'output-is-input',
        });
      }
    }
    expect(new Uint8Array(await readFile(pdfPath))).toEqual(pdf);
    expect(JSON.parse(await readFile(requestPath, 'utf8'))).toEqual(request);
  });

  it('fails before bothering the human when the request or the web dir is unusable', async () => {
    let opened = 0;
    const openBrowser = () => void (opened += 1);
    const noWeb = await runCli(['request', pdfPath, requestPath, '--web-dir', ws.path('absent')], { openBrowser });
    expect(noWeb.code).toBe(1);
    expect(noWeb.stderr).toContain('error [web-dir-missing]');

    const badRequest = await ws.write(
      'bad.json',
      JSON.stringify(await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 600, 10, 50, 20) }])),
    );
    const invalid = await runCli(['request', pdfPath, badRequest, '--web-dir', webDir], { openBrowser });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('error [field-out-of-bounds] field "sig"');

    const invalidJson = await runCli(['request', pdfPath, badRequest, '--web-dir', webDir, '--json'], { openBrowser });
    expect(invalidJson.code).toBe(1);
    expect(invalidJson.json()).toMatchObject({ ok: false, error: { code: 'field-out-of-bounds', fieldId: 'sig', errors: [{ code: 'field-out-of-bounds' }] } });
    expect(invalidJson.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(invalidJson.stderr).toMatch(/^error \[field-out-of-bounds\]: /);

    const badPort = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '--port', 'eighty'], { openBrowser });
    expect(badPort.code).toBe(1);
    expect(badPort.stderr).toContain('error [usage]');
    expect(opened).toBe(0);
  });
});
