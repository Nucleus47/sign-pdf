/**
 * The loopback hand-off: a short-lived HTTP server on 127.0.0.1 that serves the
 * built sign view to the human's browser, gives it the packet, and takes back
 * the signed PDF (or a decline, or word that a hand-off PDF went to the next
 * signer on another device).
 *
 * Contract with the web app (the full text is in the README, "Loopback protocol"):
 *   browser opens  http://127.0.0.1:<port>/#session=<nonce>
 *   POST /api/session   JSON { "nonce": "<nonce>" }      -> 200 { "token" }, once only
 *   GET  /api/packet    Authorization: Bearer <token>   -> 200 packet JSON
 *   POST /api/signed    Authorization, Content-Type: application/pdf,
 *                       X-Sign-Pdf-Sha256: <hex of body> -> 204
 *   POST /api/declined  Authorization, JSON { "reason"?: string } -> 204
 *   POST /api/handed-off Authorization, JSON { "signerId": string } -> 204
 *   every failure       4xx/5xx { "error": "<message>", "code": "<code>" }
 *
 * The link carries a one-time nonce, not the session token: whoever exchanges
 * it first holds the session, and a second exchange is told so.
 *
 * This module never signs anything. It only checks that what the browser sends
 * back looks like the signed form of this session's document and request. Those
 * checks are sanity checks, not proof: nothing authenticates the audit record.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { MAX_PDF_BYTES, checkPasses, decodePacket, encodePacket, requestSha256 } from '@sign-pdf/core';
import type { AuditRecord, Packet } from '@sign-pdf/spec';
import { readAuditRecord } from './audit.ts';
import { CliError, isExpectedError } from './errors.ts';
import { loadSecurityHeaders } from './web-dir.ts';

/** The largest PDF that core accepts. */
export const DEFAULT_MAX_BODY_BYTES = MAX_PDF_BYTES;
const MAX_DECLINE_BODY_BYTES = 64 * 1024;
const MAX_REASON_LENGTH = 2000;
const MAX_NONCE_BODY_BYTES = 4096;
const MAX_HANDED_OFF_BODY_BYTES = 4096;
/**
 * After this many wrong nonces the session stops exchanging, even for the right
 * one. If no page has opened the session yet, it then ends as cancelled with the
 * reason `locked`, so the caller does not wait for a signature that cannot come.
 */
export const MAX_BAD_NONCES = 20;
/** setTimeout cannot wait longer than 2^31 - 1 ms; a day is already generous. */
export const MAX_SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface SignedDocument {
  pdf: Uint8Array;
  sha256: string;
  /** Unauthenticated claim embedded in the file; its contents are untrusted. */
  audit: AuditRecord;
  problems: string[];
}

export type SessionResult =
  | ({ status: 'signed' } & SignedDocument)
  | { status: 'declined'; reason?: string }
  /**
   * A signer downloaded a hand-off PDF for the next signer, who signs on another
   * device. Signer ids in request order; the final PDF does not come back here.
   */
  | { status: 'handed_off'; signed: string[]; pending: string[] }
  | { status: 'timeout' }
  /** `locked`: too many wrong nonces arrived before a page opened the session. */
  | { status: 'cancelled'; reason?: 'locked' };

export interface SignSessionOptions {
  /** From core's `createPacket`: the PDF and the validated request. */
  packet: Packet;
  /** Directory of the built web app. Must contain index.html. */
  webDir: string;
  /** Default: a random free port. */
  port?: number;
  timeoutMs: number;
  maxBodyBytes?: number;
  /**
   * Called with an accepted signed PDF before the browser is told it worked.
   * If it throws (for example the file cannot be saved), the browser gets the
   * error and the session keeps waiting.
   */
  onSigned?: (signed: SignedDocument) => Promise<void>;
}

export interface SignSession {
  /**
   * What the human's browser opens: the origin plus a one-time nonce in the
   * fragment (never sent in a request line). A secret until it is exchanged:
   * never print it to stdout, log it, or return it to an agent.
   */
  url: string;
  /** `http://127.0.0.1:<port>`, safe to show. */
  origin: string;
  port: number;
  expiresAt: Date;
  /** True once a page has exchanged the nonce for the session token. */
  opened(): boolean;
  /** Settles once, after the server has closed. Never rejects. */
  result: Promise<SessionResult>;
  /** Stop waiting and close the server. Safe to call at any time, any number of times. */
  close(): Promise<void>;
}

/**
 * The only file types served, which are the ones a web build needs. Anything
 * else in the web directory (source maps, dotfiles, `_headers`) is not served.
 */
export const SERVED_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

/** Whether a path inside the web directory may be served: no dotfiles, no `_headers`, allowed types only. */
function isServable(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment !== '');
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  const name = segments.at(-1) ?? '';
  if (name === '_headers') return false;
  return Object.hasOwn(SERVED_CONTENT_TYPES, extname(name).toLowerCase());
}

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/**
 * A coarse mark of what each page draws: how many content streams and how many
 * images or forms it has. Drawing a signature adds to both, so a page whose
 * mark equals the original's had nothing drawn on it.
 */
async function pageMarks(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.size() : contents === undefined ? 0 : 1;
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length ?? 0;
    return `${streams}:${xobjects}`;
  });
}

/** Compare secrets without leaking, through timing, where they differ. */
function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}

const DEFAULT_ERROR_CODES: Readonly<Record<number, string>> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  409: 'session-finished',
  413: 'body-too-large',
  415: 'unsupported-media-type',
  422: 'rejected-document',
  500: 'internal',
};

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** Stable, machine-readable; sent as `code` beside the message. */
  readonly code: string;
  constructor(status: number, message: string, headers: Record<string, string> = {}, code?: string) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.code = code ?? DEFAULT_ERROR_CODES[status] ?? 'error';
  }
}

const rejected = (code: string, message: string): HttpError => new HttpError(422, message, {}, code);

/** Read a request body, refusing more than `limit` bytes without buffering the excess. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const tooLarge = () => new HttpError(413, `The request body is larger than the limit of ${limit} bytes.`, { Connection: 'close' });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolveBody(Buffer.concat(chunks));
    };
    const onError = () => {
      cleanup();
      reject(new HttpError(400, 'The request body could not be read.', { Connection: 'close' }));
    };
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
  });
}

/**
 * Discard what is left of a request body, within limits. An error response sent
 * while the client is still uploading would be lost to a connection reset, so
 * the rest of the body is read (not kept) first. False when the limits were hit.
 */
function drain(req: IncomingMessage, maxBytes: number, maxMs: number): Promise<boolean> {
  return new Promise((done) => {
    if (req.complete || req.destroyed) {
      done(req.complete);
      return;
    }
    let seen = 0;
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('close', onClose);
      done(ok);
    };
    const onData = (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > maxBytes) finish(false);
    };
    const onEnd = () => finish(true);
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(false), maxMs);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('close', onClose);
    req.resume();
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE' || error.code === 'EACCES'
          ? new CliError('port-unavailable', `Port ${port} on 127.0.0.1 cannot be used (${error.code}).`, 'Omit --port to use a random free port.')
          : error,
      );
    };
    server.once('error', onError);
    // Loopback only: the server is never reachable from another machine.
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The server has no TCP address.'));
        return;
      }
      resolveListen(address.port);
    });
  });
}

/** Start a session. Resolves once the server is listening. */
/**
 * For the files that the page needs again after the server has closed: the
 * hashed files of the web build (Vite writes them to `assets/` with a content
 * hash in the name) and the CMaps and standard fonts of pdf.js in `pdfjs/`
 * (fixed reference data that pdf.js may load to draw the signed PDF). Kept by
 * the browser, never by a shared cache.
 */
const STATIC_CACHE_CONTROL = 'private, max-age=86400';
/**
 * For every other static file: its name does not change when its content does,
 * so with a fixed --port the browser must not reuse a copy from an older build.
 */
const UNHASHED_CACHE_CONTROL = 'no-cache';

export async function startSignSession(options: SignSessionOptions): Promise<SignSession> {
  const { packet } = options;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_SESSION_TIMEOUT_MS) {
    throw new CliError('usage', `The timeout must be more than 0 and at most ${MAX_SESSION_TIMEOUT_MS / 1000} seconds.`);
  }
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new CliError('usage', 'The port must be a whole number from 0 to 65535.');
  }

  const webRoot = await realpath(resolve(options.webDir)).catch(() => {
    throw new CliError('web-dir-missing', `The web directory does not exist: ${options.webDir}`);
  });
  const indexHtml = join(webRoot, 'index.html');
  const securityHeaders = await loadSecurityHeaders(webRoot);
  const packetJson = Buffer.from(encodePacket(packet), 'utf8');
  const expectedDocumentSha256 = packet.request.document.sha256;
  const expectedRequestSha256 = await requestSha256(packet.request);
  const original = (await decodePacket(packetJson.toString('utf8'))).pdf;
  const originalMarks = await pageMarks(original);
  // Each 256 bits, URL-safe. The nonce goes in the link and works once; the token never leaves the page that got it.
  const nonce = randomBytes(32).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  let opened = false;
  let badNonces = 0;

  let port = 0;
  let settled = false;
  let accepting = false;
  let expired = false;
  let closing: Promise<void> | undefined;
  let finish: (result: SessionResult) => void = () => {};
  const result = new Promise<SessionResult>((resolveResult) => {
    finish = resolveResult;
  });

  const send = (
    res: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body?: Buffer | string,
    head = false,
  ): Promise<void> =>
    new Promise((done) => {
      if (res.destroyed || res.socket?.destroyed) {
        done();
        return;
      }
      const payload = body === undefined ? undefined : Buffer.from(body);
      res.writeHead(status, {
        ...securityHeaders,
        'Cache-Control': 'no-store',
        ...headers,
        ...(payload ? { 'Content-Length': String(payload.length) } : {}),
      });
      res.once('close', done);
      res.end(head ? undefined : payload);
    });

  const sendError = (res: ServerResponse, error: HttpError): Promise<void> =>
    send(
      res,
      error.status,
      { 'Content-Type': 'application/json', ...error.headers },
      JSON.stringify({ error: error.message, code: error.code }),
    );

  /** DNS rebinding and cross-site requests stop here, before any routing. */
  function checkOrigin(req: IncomingMessage): string {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new HttpError(403, 'This server only answers requests addressed to its own loopback address.');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      throw new HttpError(403, 'Requests from another origin are not allowed.');
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new HttpError(403, 'Requests from another site are not allowed.');
    }
    return host;
  }

  /** The one-time exchange: the nonce from the link for the session token. */
  async function exchangeNonce(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') throw new HttpError(415, 'Send { "nonce": "..." } with Content-Type: application/json.');
    const body = await readBody(req, MAX_NONCE_BODY_BYTES);
    let given: unknown;
    try {
      const json: unknown = JSON.parse(body.toString('utf8'));
      given = typeof json === 'object' && json !== null ? (json as { nonce?: unknown }).nonce : undefined;
    } catch {
      given = undefined;
    }
    if (typeof given !== 'string' || given === '') throw new HttpError(400, 'The body must be JSON such as { "nonce": "..." }.');
    const locked = (): HttpError =>
      new HttpError(429, 'Too many wrong attempts: this signing link is locked. Start a new signature request.', {}, 'session-locked');
    if (badNonces >= MAX_BAD_NONCES) throw locked();
    if (!sameSecret(given, nonce)) {
      // A wrong guess does not use up the real nonce; it only counts toward the lock.
      badNonces += 1;
      if (badNonces < MAX_BAD_NONCES) throw new HttpError(401, 'This signing link is not valid.', {}, 'invalid-nonce');
      // Locked. With no page holding the token, nobody can sign any more: end the session now.
      if (!opened && !settled) {
        settled = true;
        await sendError(res, locked());
        await settle({ status: 'cancelled', reason: 'locked' });
        return;
      }
      throw locked();
    }
    if (opened) {
      throw new HttpError(
        401,
        'This signing link was already opened in another tab or by another program. Start a new signature request.',
        {},
        'session-already-opened',
      );
    }
    opened = true;
    await send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ token }));
  }

  function checkToken(req: IncomingMessage): void {
    const header = req.headers.authorization;
    const given = header !== undefined && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (given === undefined || !sameSecret(given, token)) {
      throw new HttpError(401, 'Missing or wrong session token.', { 'WWW-Authenticate': 'Bearer' });
    }
  }

  function requireMethod(req: IncomingMessage, method: string): void {
    if (req.method !== method) throw new HttpError(405, `Use ${method} for this path.`, { Allow: method });
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Use GET for this path.', { Allow: 'GET, HEAD' });
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Malformed path.');
    }
    if (decoded.includes('\0')) throw new HttpError(400, 'Malformed path.');

    let file = indexHtml;
    const candidate = resolve(webRoot, `.${sep}${decoded}`);
    // The resolved path, and the real path behind any symlink, must stay inside the web dir.
    if (candidate.startsWith(webRoot + sep)) {
      const real = await realpath(candidate).catch(() => undefined);
      if (real !== undefined && real.startsWith(webRoot + sep) && (await stat(real)).isFile()) {
        // A file that exists but is not on the allow-list is refused, by its name and by its real name.
        if (!isServable(candidate.slice(webRoot.length + 1)) || !isServable(real.slice(webRoot.length + 1))) {
          throw new HttpError(404, 'Not found.');
        }
        file = real;
      } else if (basename(candidate).startsWith('.') || basename(candidate) === '_headers') {
        throw new HttpError(404, 'Not found.');
      }
    }
    const data = await readFile(file);
    const type = SERVED_CONTENT_TYPES[extname(file).toLowerCase()] ?? 'text/html; charset=utf-8';
    // The page shows the signed PDF after the hand-back, when this server is already closed. It then
    // starts its PDF worker and reads its fonts again, so the browser must be allowed to keep the
    // hashed files of the web build and the pdf.js data. They are public and the same for every session.
    // The HTML shell is not kept (no-store), and every other file is checked again on each use (no-cache).
    const top = file === indexHtml ? '' : (relative(webRoot, file).split(sep)[0] ?? '');
    const kept = top === 'assets' || top === 'pdfjs';
    const cache: Record<string, string> = type.startsWith('text/html')
      ? {}
      : { 'Cache-Control': kept ? STATIC_CACHE_CONTROL : UNHASHED_CACHE_CONTROL };
    await send(res, 200, { 'Content-Type': type, ...cache }, data, req.method === 'HEAD');
  }

  async function acceptSigned(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/pdf') throw new HttpError(415, 'Send the signed PDF with Content-Type: application/pdf.');
    const declared = req.headers['x-sign-pdf-sha256'];
    if (typeof declared !== 'string' || !/^[0-9a-f]{64}$/.test(declared)) {
      throw new HttpError(400, 'The X-Sign-Pdf-Sha256 header must be the lowercase hex SHA-256 of the body.');
    }
    const body = await readBody(req, maxBodyBytes);
    if (body.length === 0) throw new HttpError(400, 'The request body is empty.');
    const actual = sha256(body);
    if (actual !== declared) {
      throw new HttpError(400, 'The body does not match the X-Sign-Pdf-Sha256 header: the upload was damaged. Try again.');
    }
    if (settled || accepting) throw new HttpError(409, 'This session already has a result.');
    accepting = true;
    try {
      const pdf = new Uint8Array(body);
      let check;
      try {
        check = await readAuditRecord(pdf);
      } catch (error) {
        if (!isExpectedError(error)) throw error;
        throw rejected('not-a-pdf', `The upload is not a readable PDF: ${error instanceof Error ? error.message : ''}`);
      }
      if (actual === expectedDocumentSha256 || Buffer.compare(body, original) === 0) {
        throw rejected('unchanged-document', 'The upload is the original PDF: nothing was signed.');
      }
      if (!check.hasAuditRecord || !check.audit) {
        throw rejected('no-audit-record', `The PDF has no sign-pdf audit record. ${check.problems.join(' ')}`.trim());
      }
      const audit = check.audit;
      if (audit.document.originalSha256 !== expectedDocumentSha256) {
        throw rejected('wrong-document', "The PDF was not made from this session's document.");
      }
      if (audit.requestSha256 !== expectedRequestSha256) {
        throw rejected('wrong-request', "The PDF was not made from this session's sign request.");
      }
      // A request with several signers needs one pass per signer, in the request's order.
      const signers = packet.request.signers;
      if (signers !== undefined) {
        const passes = audit.passes ?? [];
        const missing = signers.find((signer, index) => passes[index]?.signerId !== signer.id);
        if (missing) {
          throw rejected('missing-signer-pass', `The audit record has no signing pass for the signer "${missing.id}" in its turn.`);
        }
        if (passes.length !== signers.length) {
          throw rejected('missing-signer-pass', 'The audit record has more signing passes than the request has signers.');
        }
        // Who owns what comes from this session's request, never from the record's own claims.
        const signerIds = new Set(signers.map((signer) => signer.id));
        for (const [index, signer] of signers.entries()) {
          const owned = packet.request.fields.filter((field) => field.signerId === signer.id).map((field) => field.id);
          if (JSON.stringify(passes[index]?.fieldIds) !== JSON.stringify(owned)) {
            throw rejected('missing-signer-pass', `The signing pass of "${signer.id}" does not list exactly the fields that signer owns.`);
          }
        }
        for (const field of packet.request.fields) {
          const entry = audit.fields.find((candidate) => candidate.id === field.id);
          if (entry === undefined) continue;
          const wrong = field.signerId !== undefined ? entry.signerId !== field.signerId : entry.signerId !== undefined && !signerIds.has(entry.signerId);
          if (wrong) throw rejected('missing-signer-pass', `The audit record gives the field "${field.id}" to the wrong signer.`);
        }
        const chain = await checkPasses(audit);
        if (chain.length > 0) throw rejected('missing-signer-pass', `The signing passes do not hold together: ${chain.join(' ')}`);
      }
      // The record must account for every field of the request, and show a signature on every one that needs it.
      const signedPages = new Set<number>();
      for (const field of packet.request.fields) {
        const entry = audit.fields.find((candidate) => candidate.id === field.id);
        const signing = field.type === 'signature' || field.type === 'initials';
        if (!entry || entry.type !== field.type) {
          if (!signing && !field.required) continue;
          throw rejected('incomplete-audit-record', `The audit record has no entry for the ${field.type} field "${field.id}".`);
        }
        if (!signing) continue;
        const hasSignature = entry.signatureMethod !== undefined && entry.signatureSha256 !== undefined;
        if (hasSignature) signedPages.add(entry.rect.page);
        else if (field.required) throw rejected('missing-signature', `The ${field.type} field "${field.id}" is not signed.`);
      }
      let marks: string[];
      try {
        marks = await pageMarks(pdf);
      } catch {
        throw rejected('not-a-pdf', 'The upload is not a readable PDF.');
      }
      if (marks.length !== originalMarks.length) throw rejected('wrong-document', 'The PDF does not have the pages of this session\'s document.');
      for (const page of signedPages) {
        if (marks[page - 1] === undefined || marks[page - 1] === originalMarks[page - 1]) {
          throw rejected('unchanged-page', `Page ${page} is recorded as signed, but nothing was drawn on it.`);
        }
      }
      const signed: SignedDocument = { pdf, sha256: actual, audit, problems: check.problems };
      // The session was closed while the upload was being checked.
      if (settled) throw new HttpError(409, 'This session has ended.');
      if (options.onSigned) {
        try {
          await options.onSigned(signed);
        } catch (error) {
          throw new HttpError(
            500,
            `The signed PDF could not be saved: ${error instanceof Error ? error.message : String(error)} Keep this page open and try again.`,
            {},
            'save-failed',
          );
        }
      }
      settled = true;
      await send(res, 204, { Connection: 'close' });
      await settle({ status: 'signed', ...signed });
    } finally {
      accepting = false;
      // The timeout passed while a rejected upload was being checked.
      if (expired && !settled) {
        settled = true;
        void settle({ status: 'timeout' });
      }
    }
  }

  async function acceptDeclined(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, MAX_DECLINE_BODY_BYTES);
    let reason: string | undefined;
    if (body.length > 0) {
      let json: unknown;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        throw new HttpError(400, 'The body must be JSON such as { "reason": "..." }.');
      }
      const given: unknown = typeof json === 'object' && json !== null ? (json as { reason?: unknown }).reason : undefined;
      if (given !== undefined && typeof given !== 'string') throw new HttpError(400, '"reason" must be a string.');
      reason = given?.slice(0, MAX_REASON_LENGTH);
    }
    if (settled || accepting) throw new HttpError(409, 'This session already has a result.');
    settled = true;
    await send(res, 204, { Connection: 'close' });
    await settle(reason === undefined || reason === '' ? { status: 'declined' } : { status: 'declined', reason });
  }

  /**
   * The signer who just finished downloaded a hand-off PDF for the next signer.
   * The body names that signer and nothing else: no signature, no PDF. The
   * signer must have a turn in this session and must not be the last one.
   */
  async function acceptHandedOff(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') throw new HttpError(415, 'Send { "signerId": "..." } with Content-Type: application/json.');
    const body = await readBody(req, MAX_HANDED_OFF_BODY_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      json = undefined;
    }
    const keys = typeof json === 'object' && json !== null && !Array.isArray(json) ? Object.keys(json) : [];
    const signerId: unknown = keys.length === 1 && keys[0] === 'signerId' ? (json as { signerId: unknown }).signerId : undefined;
    if (typeof signerId !== 'string' || signerId === '') {
      throw new HttpError(400, 'The body must be JSON with only a "signerId" string, such as { "signerId": "a" }.');
    }
    const signers = packet.request.signers ?? [];
    const index = signers.findIndex((signer) => signer.id === signerId);
    const firstTurn = packet.passes?.length ?? 0;
    if (index < firstTurn || index >= signers.length - 1) {
      throw new HttpError(
        422,
        signers.length < 2
          ? 'This request has no next signer to hand off to.'
          : `"${signerId}" is not a signer of this session who has a next signer.`,
        {},
        'wrong-signer',
      );
    }
    if (settled || accepting) throw new HttpError(409, 'This session already has a result.');
    settled = true;
    await send(res, 204, { Connection: 'close' });
    await settle({
      status: 'handed_off',
      signed: signers.slice(0, index + 1).map((signer) => signer.id),
      pending: signers.slice(index + 1).map((signer) => signer.id),
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = checkOrigin(req);
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', `http://${host}`).pathname;
    } catch {
      throw new HttpError(400, 'Malformed request URL.');
    }
    if (pathname !== '/api' && !pathname.startsWith('/api/')) {
      await serveStatic(req, res, pathname);
      return;
    }
    if (pathname === '/api/session') {
      requireMethod(req, 'POST');
      await exchangeNonce(req, res);
      return;
    }
    checkToken(req);
    if (pathname === '/api/packet') {
      requireMethod(req, 'GET');
      await send(res, 200, { 'Content-Type': 'application/json' }, packetJson);
    } else if (pathname === '/api/signed') {
      requireMethod(req, 'POST');
      await acceptSigned(req, res);
    } else if (pathname === '/api/declined') {
      requireMethod(req, 'POST');
      await acceptDeclined(req, res);
    } else if (pathname === '/api/handed-off') {
      requireMethod(req, 'POST');
      await acceptHandedOff(req, res);
    } else {
      throw new HttpError(404, 'Unknown API path.');
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(async (error: unknown) => {
      const httpError =
        error instanceof HttpError ? error : new HttpError(500, 'Internal error.', { Connection: 'close' });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const drained = await drain(req, 2 * maxBodyBytes, 10_000);
      if (!drained) httpError.headers['Connection'] = 'close';
      await sendError(res, httpError).catch(() => undefined);
      if (!drained) req.socket.destroy();
    });
  });
  // The sign view needs no long-lived connections; idle ones must not hold the server open.
  server.keepAliveTimeout = 1000;

  const timer = setTimeout(() => {
    expired = true;
    // An upload that is being checked right now may still succeed.
    if (settled || accepting) return;
    settled = true;
    void settle({ status: 'timeout' });
  }, options.timeoutMs);

  function shutdown(): Promise<void> {
    closing ??= new Promise<void>((done) => {
      clearTimeout(timer);
      server.close(() => done());
      server.closeAllConnections();
    });
    return closing;
  }

  /** Close the server first, then report: whoever awaits the result finds no open handle. */
  async function settle(outcome: SessionResult): Promise<void> {
    await shutdown();
    finish(outcome);
  }

  try {
    port = await listen(server, requestedPort);
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }

  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/#session=${nonce}`,
    origin,
    port,
    opened: () => opened,
    expiresAt: new Date(Date.now() + options.timeoutMs),
    result,
    close: async () => {
      if (!settled) {
        settled = true;
        await settle({ status: 'cancelled' });
      } else {
        await shutdown();
      }
    },
  };
}
