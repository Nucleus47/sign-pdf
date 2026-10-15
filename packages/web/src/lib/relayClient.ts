/**
 * The relay client: the first signer's side of the optional relay API
 * (docs/relay.md, issue #65). Modelled on ./transport.ts: an injected fetch,
 * a time limit on every request and stable error codes mapped to words for
 * the person signing.
 *
 *   GET  /relay/config               → { turnstileSiteKey }
 *   POST /relay/login                { email, turnstile } → { ok: true }
 *   POST /relay/login/verify         { email, code } → { session, expiresAt }
 *   PUT  /relay/docs/:id             Bearer; X-Relay-To, X-Relay-Password; raw ciphertext → { id, expiresAt }
 *   POST /relay/docs/:id/send        Bearer; { key, wrappedKey? } → { ok: true }
 *   GET  /relay/docs/:id             → raw ciphertext; header X-Relay-Password: 0|1 (the next signer)
 *   PUT  /relay/docs/:id/final       raw ciphertext → { ok: true } (the next signer)
 *   GET  /relay/docs/:id/final       X-Relay-Code → raw ciphertext; header X-Relay-Wrapped-Key when a passphrase was set (the first signer)
 *   DELETE /relay/docs/:id           → 204 (the first signer, once the signed PDF is saved)
 *
 * The document key goes in one request only: the body of `/send`. It is never
 * in a URL, a header, storage or an error. The wrapped key (issue #105) goes
 * in the same body and comes back with the signed PDF; only the passphrase,
 * which never leaves this device, opens it. The session token is kept in
 * memory and in this tab's sessionStorage until it expires (24 hours).
 */
import {
  CreateDocResponse,
  OkResponse,
  RELAY_MAX_BLOB_BYTES,
  RELAY_PATH_PREFIX,
  RelayConfigResponse,
  RelayWrappedKey,
  SessionResponse,
} from '@sign-pdf/spec';
import type { FetchLike } from './transport.ts';

export const RELAY_CONFIG_PATH = `${RELAY_PATH_PREFIX}/config`;
export const RELAY_LOGIN_PATH = `${RELAY_PATH_PREFIX}/login`;
export const RELAY_VERIFY_PATH = `${RELAY_PATH_PREFIX}/login/verify`;
export const relayDocPath = (id: string) => `${RELAY_PATH_PREFIX}/docs/${encodeURIComponent(id)}`;
export const relaySendPath = (id: string) => `${relayDocPath(id)}/send`;
export const relayFinalPath = (id: string) => `${relayDocPath(id)}/final`;

/** How long a small JSON request gets. */
export const RELAY_JSON_TIMEOUT_MS = 20_000;
/** How long the upload gets: up to 40 MiB on a slow connection. */
export const RELAY_UPLOAD_TIMEOUT_MS = 180_000;

const SESSION_STORAGE_KEY = 'sign-pdf.relay.session';

export interface RelaySession {
  session: string;
  /** ISO time from the relay. */
  expiresAt: string;
}

/**
 * - `unauthorized`: the sign-in ran out or is not valid; sign in again.
 * - `bad-code`: a wrong, used, expired or locked sign-in code.
 * - `too-large`: the encrypted document is over the relay's cap.
 * - `rate-limited`: too many requests; wait a minute.
 * - `already-sent`: the next signer was already emailed for this document.
 * - `send-pending`: another request is emailing the next signer right now.
 * - `not-found`: the relay has no such document for this sign-in (expired, or
 *   uploaded under another sign-in); start again with a new upload.
 * - `id-taken`: the document id is in use; a new id works.
 * - `email-failed`: the relay could not send the email; trying again can work.
 * - `not-available`: no relay at this address (a static or local server).
 * - `unreachable`: no answer, in time or at all.
 * - `bad-request`, `server-error`, `unexpected`: anything else.
 */
export type RelayErrorCode =
  | 'unauthorized'
  | 'bad-code'
  | 'too-large'
  | 'rate-limited'
  | 'already-sent'
  | 'send-pending'
  | 'not-found'
  | 'id-taken'
  | 'email-failed'
  | 'not-available'
  | 'unreachable'
  | 'bad-request'
  | 'server-error'
  | 'unexpected';

export type RelayResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RelayErrorCode; error: string; status?: number };

/** What each error means, in words for the person signing. */
export const RELAY_ERROR_TEXT: Readonly<Record<RelayErrorCode, string>> = {
  unauthorized: 'Your sign-in for email ran out. Sign in again.',
  'bad-code': 'The code is wrong or ran out. Check the latest email, or ask for a new code.',
  'too-large': 'The document is too large to email. Download the PDF instead.',
  'rate-limited': 'Too many tries. Wait a minute, then try again.',
  'already-sent': 'The email for this document was already sent.',
  'send-pending': 'The email is still being sent. Wait a minute, then try again.',
  'not-found': 'The email service no longer has this upload. Try again to upload it again.',
  'id-taken': 'The upload did not go through. Try again.',
  'email-failed': 'The email could not be sent. Try again.',
  'not-available': 'Email is not available on this server. Download the PDF instead.',
  unreachable: 'The email service did not answer. Check your connection, then try again.',
  'bad-request': 'The email service refused the request. Check the email address, then try again.',
  'server-error': 'The email service had a problem. Try again later.',
  unexpected: 'The email service gave an answer this page does not understand.',
};

const KNOWN_CODES = new Set<string>(Object.keys(RELAY_ERROR_TEXT));

class TimedOut extends Error {}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimedOut());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), limit]);
  } finally {
    clearTimeout(timer);
  }
}

function failure<T>(code: RelayErrorCode, status?: number): RelayResult<T> {
  return status === undefined
    ? { ok: false, code, error: RELAY_ERROR_TEXT[code] }
    : { ok: false, code, status, error: RELAY_ERROR_TEXT[code] };
}

function isJson(response: Response): boolean {
  const type = response.headers.get('content-type') ?? '';
  return type.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

async function body(response: Response): Promise<unknown> {
  if (!isJson(response)) return null;
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The error code for a non-2xx answer: the relay's own code, else one from the status. */
function codeOf(status: number, answer: unknown): RelayErrorCode {
  const given = typeof answer === 'object' && answer !== null ? (answer as { code?: unknown }).code : undefined;
  if (typeof given === 'string' && KNOWN_CODES.has(given)) return given as RelayErrorCode;
  if (given === 'final-exists') return 'already-sent';
  // Not the relay's error shape: a server without the relay (a static host, the CLI).
  if (given === undefined && (status === 404 || status === 405)) return 'not-available';
  if (status === 401) return 'unauthorized';
  if (status === 409) return 'already-sent';
  if (status === 411 || status === 413) return 'too-large';
  if (status === 429) return 'rate-limited';
  if (status === 502) return 'email-failed';
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'bad-request';
  return 'unexpected';
}

/** The body, or null once it passes `cap` bytes (a missing Content-Length cannot be trusted). */
async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface RelayClientOptions {
  fetch?: FetchLike;
  /** This tab's sessionStorage; undefined keeps the session in memory only. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
  now?: () => number;
  jsonTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

export interface UploadInput {
  /** The id the blob was encrypted for (the browser chooses it). */
  id: string;
  /** The next signer's email address. */
  to: string;
  /** True when the first signer set a password. */
  password: boolean;
  /** The encrypted hand-off packet. */
  blob: Uint8Array;
}

/** The encrypted signed PDF as the relay serves it to the first signer. */
export interface FetchedFinal {
  blob: Uint8Array;
  /** The document key wrapped with the passphrase; absent when the first signer set none. */
  wrappedKey?: string;
}

/** The encrypted hand-off as the relay serves it to the next signer. */
export interface FetchedHandoff {
  blob: Uint8Array;
  /** True when the relay says the first signer set a password. */
  password: boolean;
}

export interface RelayClient {
  config(): Promise<RelayResult<RelayConfigResponse>>;
  login(email: string, turnstile: string): Promise<RelayResult<null>>;
  verify(email: string, code: string): Promise<RelayResult<RelaySession>>;
  uploadHandoff(session: RelaySession, input: UploadInput): Promise<RelayResult<CreateDocResponse>>;
  /** Email the next signer the link. `wrappedKey` goes with it when a passphrase was set. */
  send(session: RelaySession, id: string, key: string, wrappedKey?: string): Promise<RelayResult<null>>;
  /** The next signer: the encrypted hand-off. No sign-in; the id is the capability. */
  fetchHandoff(id: string): Promise<RelayResult<FetchedHandoff>>;
  /** The next signer: upload the encrypted signed PDF once. A final already there is `already-sent`. */
  uploadFinal(id: string, blob: Uint8Array): Promise<RelayResult<null>>;
  /** The first signer: the encrypted signed PDF, for the 6-digit code from the email. Each call uses one of five attempts. */
  fetchFinal(id: string, code: string): Promise<RelayResult<FetchedFinal>>;
  /** The first signer: delete everything the relay keeps for this document. */
  deleteDoc(id: string): Promise<RelayResult<null>>;
  /** The live session from verify, or null when there is none or it ran out. */
  currentSession(): RelaySession | null;
  clearSession(): void;
}

export function createRelayClient(options: RelayClientOptions = {}): RelayClient {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const storage = options.storage;
  const now = options.now ?? Date.now;
  const jsonTimeout = options.jsonTimeoutMs ?? RELAY_JSON_TIMEOUT_MS;
  const uploadTimeout = options.uploadTimeoutMs ?? RELAY_UPLOAD_TIMEOUT_MS;
  let memory: RelaySession | null = null;

  const live = (candidate: RelaySession | null): RelaySession | null =>
    candidate && Date.parse(candidate.expiresAt) > now() ? candidate : null;

  const clearSession = () => {
    memory = null;
    try {
      storage?.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // No storage: memory is all there is.
    }
  };

  const keepSession = (session: RelaySession) => {
    memory = session;
    try {
      storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // No storage (private mode, blocked): the session lasts for this page only.
    }
  };

  const currentSession = (): RelaySession | null => {
    if (live(memory)) return memory;
    memory = null;
    let stored: RelaySession | null = null;
    try {
      const text = storage?.getItem(SESSION_STORAGE_KEY);
      if (text) {
        const parsed = SessionResponse.safeParse(JSON.parse(text));
        if (parsed.success) stored = parsed.data;
      }
    } catch {
      stored = null;
    }
    const usable = live(stored);
    if (usable) memory = usable;
    else clearSession();
    return usable;
  };

  async function request<T>(
    path: string,
    init: RequestInit,
    schema: Schema<T>,
    timeoutMs: number,
  ): Promise<RelayResult<T>> {
    let answer: { status: number; ok: boolean; json: unknown };
    try {
      answer = await withTimeout(async (signal) => {
        const response = await fetchImpl(path, { ...init, cache: 'no-store', credentials: 'omit', signal });
        return { status: response.status, ok: response.ok, json: await body(response) };
      }, timeoutMs);
    } catch {
      // Never the error's message: it can quote the request.
      return failure('unreachable');
    }
    if (!answer.ok) {
      const code = codeOf(answer.status, answer.json);
      if (code === 'unauthorized') clearSession();
      return failure(code, answer.status);
    }
    const parsed = schema.safeParse(answer.json);
    return parsed.success ? { ok: true, value: parsed.data } : failure('unexpected', answer.status);
  }

  /** A raw (non-JSON) download of at most RELAY_MAX_BLOB_BYTES. */
  async function download(
    path: string,
    timeoutMs: number,
    headers: Record<string, string> = {},
  ): Promise<RelayResult<{ bytes: Uint8Array; password: string | null; wrappedKey: string | null }>> {
    let answer: {
      status: number;
      ok: boolean;
      json: unknown;
      bytes: Uint8Array | null;
      password: string | null;
      wrappedKey?: string | null;
    };
    try {
      answer = await withTimeout(async (signal) => {
        const response = await fetchImpl(path, { method: 'GET', headers, cache: 'no-store', credentials: 'omit', signal });
        if (!response.ok) {
          return { status: response.status, ok: false, json: await body(response), bytes: null, password: null };
        }
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (declared > RELAY_MAX_BLOB_BYTES) return { status: 413, ok: false, json: null, bytes: null, password: null };
        const bytes = await readCapped(response, RELAY_MAX_BLOB_BYTES);
        if (!bytes) return { status: 413, ok: false, json: null, bytes: null, password: null };
        return {
          status: response.status,
          ok: true,
          json: null,
          bytes,
          password: response.headers.get('x-relay-password'),
          wrappedKey: response.headers.get('x-relay-wrapped-key'),
        };
      }, timeoutMs);
    } catch {
      return failure('unreachable');
    }
    if (!answer.ok || !answer.bytes) return failure(codeOf(answer.status, answer.json), answer.status);
    return { ok: true, value: { bytes: answer.bytes, password: answer.password, wrappedKey: answer.wrappedKey ?? null } };
  }

  const asNull = <T>(result: RelayResult<T>): RelayResult<null> => (result.ok ? { ok: true, value: null } : result);

  const jsonInit = (payload: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const bearer = (session: RelaySession) => ({ Authorization: `Bearer ${session.session}` });

  return {
    config: async () => {
      const result = await request(RELAY_CONFIG_PATH, { method: 'GET' }, RelayConfigResponse, jsonTimeout);
      // A server without the relay (the CLI, a static host) can answer 200 with its index.html.
      if (!result.ok && result.code === 'unexpected' && result.status !== undefined && result.status < 300) {
        return failure('not-available', result.status);
      }
      return result;
    },

    login: async (email, turnstile) =>
      asNull(await request(RELAY_LOGIN_PATH, jsonInit({ email, turnstile }), OkResponse, jsonTimeout)),

    verify: async (email, code) => {
      const result = await request(RELAY_VERIFY_PATH, jsonInit({ email, code }), SessionResponse, jsonTimeout);
      if (result.ok) keepSession(result.value);
      return result;
    },

    uploadHandoff: async (session, input) => {
      const result = await request(
        relayDocPath(input.id),
        {
          method: 'PUT',
          headers: {
            ...bearer(session),
            'Content-Type': 'application/octet-stream',
            // A browser sets Content-Length from the Blob itself and drops this
            // one; a fetch outside the browser sends it as written.
            'Content-Length': String(input.blob.byteLength),
            'X-Relay-To': input.to,
            'X-Relay-Password': input.password ? '1' : '0',
          },
          body: new Blob([input.blob.slice()], { type: 'application/octet-stream' }),
        },
        CreateDocResponse,
        uploadTimeout,
      );
      // The relay stores the blob under the id it was encrypted for, or the link cannot open it.
      if (result.ok && result.value.id !== input.id) return failure('unexpected');
      return result;
    },

    send: async (session, id, key, wrappedKey) =>
      asNull(
        await request(
          relaySendPath(id),
          jsonInit(wrappedKey === undefined ? { key } : { key, wrappedKey }, bearer(session)),
          OkResponse,
          jsonTimeout,
        ),
      ),

    fetchHandoff: async (id) => {
      const result = await download(relayDocPath(id), uploadTimeout);
      if (!result.ok) return result;
      const { bytes, password } = result.value;
      if (password !== '0' && password !== '1') return failure('unexpected');
      return { ok: true, value: { blob: bytes, password: password === '1' } };
    },

    fetchFinal: async (id, code) => {
      // Checked here too, so a malformed code never uses up an attempt.
      if (!/^\d{6}$/.test(code)) return failure('bad-code');
      const result = await download(relayFinalPath(id), uploadTimeout, { 'X-Relay-Code': code });
      if (!result.ok) return result;
      const { bytes, wrappedKey } = result.value;
      if (wrappedKey === null) return { ok: true, value: { blob: bytes } };
      // A header that is not a wrapped key is an answer this page does not understand.
      if (!RelayWrappedKey.safeParse(wrappedKey).success) return failure('unexpected', 200);
      return { ok: true, value: { blob: bytes, wrappedKey } };
    },

    deleteDoc: async (id) => {
      try {
        const status = await withTimeout(async (signal) => {
          const response = await fetchImpl(relayDocPath(id), { method: 'DELETE', cache: 'no-store', credentials: 'omit', signal });
          return response.status;
        }, jsonTimeout);
        return status === 204 || status === 200 ? { ok: true, value: null } : failure(codeOf(status, null), status);
      } catch {
        return failure('unreachable');
      }
    },

    uploadFinal: async (id, blob) => {
      const result = await request(
        relayFinalPath(id),
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(blob.byteLength),
          },
          body: new Blob([blob.slice()], { type: 'application/octet-stream' }),
        },
        OkResponse,
        uploadTimeout,
      );
      return asNull(result);
    },

    currentSession,
    clearSession,
  };
}

function tabStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

let active: RelayClient | undefined;

/** The app's relay client. Tests swap it with setRelayClient. */
export function relayClient(): RelayClient {
  active ??= createRelayClient({ storage: tabStorage() });
  return active;
}

/** Use another client (tests); returns a function that restores the previous one. */
export function setRelayClient(client: RelayClient): () => void {
  const previous = active;
  active = client;
  return () => {
    active = previous;
  };
}
