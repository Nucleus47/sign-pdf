/**
 * Loopback session: how a local CLI hands a document to the human and gets
 * the signed PDF back. The contract is the "Loopback protocol" section of
 * packages/cli/README.md; this file is the page's side of it.
 *
 *   page URL        …/#session=<nonce>      (the nonce works once; it is not the token)
 *   POST /api/session    Content-Type: application/json, body = { "nonce": "<nonce>" }
 *                        200 + { "token": "<token>" }, exactly once
 *   GET  /api/packet     Authorization: Bearer <token>
 *                        200 + application/json + { kind: "sign-pdf-packet", … }
 *   POST /api/signed     Authorization, Content-Type: application/pdf,
 *                        X-Sign-Pdf-Sha256: <hex>, body = signed PDF bytes
 *   POST /api/declined   Authorization, Content-Type: application/json,
 *                        body = { "reason": "<optional text>" }
 *   every error          { "error": "<sentence>", "code": "<stable code>" }
 *
 * The token lives in memory only: never in storage, never in the address, never
 * in a log. Without a nonce in the URL nothing here runs: the hosted static
 * site makes no request beyond its own assets.
 */
import { PACKET_KIND } from '@sign-pdf/spec';

export const SESSION_PATH = '/api/session';
export const PACKET_PATH = '/api/packet';
export const SIGNED_PATH = '/api/signed';
export const DECLINED_PATH = '/api/declined';
export const HANDED_OFF_PATH = '/api/handed-off';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SESSION_PARAM = /(^|[#&?/])session=([^&#]*)/;

/** The one-time session nonce in a URL fragment, or null. */
export function readSessionNonce(hash: string): string | null {
  const match = SESSION_PARAM.exec(hash);
  if (!match?.[2]) return null;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return match[2];
  }
}

/** The fragment with the session nonce removed (other fragment parts are kept). */
export function hashWithoutSession(hash: string): string {
  const rest = hash
    .replace(/^#/, '')
    .split('&')
    .filter((part) => part !== '' && !/^[?/]*session=/.test(part))
    .join('&');
  return rest ? `#${rest}` : '';
}

/** Take the nonce out of the address bar, so it is not kept or copied with the address. */
export function removeSessionFromAddressBar(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  history: Pick<History, 'replaceState' | 'state'>,
): void {
  const next = `${location.pathname}${location.search}${hashWithoutSession(location.hash)}`;
  history.replaceState(history.state, '', next);
}

const SESSION_LINK_MARK = 'sign-pdf:session-link-used';

/**
 * Remember, for this tab only (sessionStorage), that it was opened with a
 * signing link. Only the fact is kept: the nonce and the token stay in memory.
 */
export function markSessionLinkUsed(storage: Pick<Storage, 'setItem'> | undefined): void {
  try {
    storage?.setItem(SESSION_LINK_MARK, '1');
  } catch {
    // No storage (private mode, blocked): a reload then shows the start page.
  }
}

/**
 * True when this tab was opened with a signing link and then loaded again
 * without it (a reload). The mark is removed, so this is true once.
 */
export function takeSessionLinkUsed(storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined): boolean {
  try {
    if (storage?.getItem(SESSION_LINK_MARK) !== '1') return false;
    storage.removeItem(SESSION_LINK_MARK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a signing link cannot be used.
 * - `already-opened`: the nonce was exchanged before this page asked.
 * - `not-valid`: wrong, locked, finished, or not a signing link at all.
 * - `unreachable`: no answer (in time, or at all); asking again can work.
 */
export type SessionProblem = 'already-opened' | 'not-valid' | 'unreachable';

export type SessionOpenResult =
  | { ok: true; token: string }
  | { ok: false; problem: SessionProblem; reason: string };

export type SessionPacketResult =
  | { active: true; packetText: string }
  | { active: false; problem: Exclude<SessionProblem, 'already-opened'>; reason: string };

/** How long the local app gets to open the session, and to hand over the packet. */
export const PACKET_TIMEOUT_MS = 15_000;
/** How long the local app gets to take the signed PDF or the decline. */
export const POST_TIMEOUT_MS = 30_000;

class TimedOut extends Error {}

/**
 * Run a request with a time limit. The request is aborted at the limit, and
 * the wait ends even if the fetch implementation ignores the abort signal.
 */
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

function seconds(ms: number): string {
  const value = Math.round(ms / 1000);
  return `${value} second${value === 1 ? '' : 's'}`;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function isJson(response: Response): boolean {
  const type = response.headers.get('content-type') ?? '';
  return type.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** A JSON object body, or null when the answer is anything else. */
async function jsonObject(response: Response): Promise<Record<string, unknown> | null> {
  if (!isJson(response)) return null;
  try {
    const body: unknown = JSON.parse(await response.text());
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch (error) {
    // Only a body that is not JSON means "no object"; an aborted read is still a failure.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The stable `code` of an error body, or null when the answer is not the contract's error shape. */
async function errorCode(response: Response): Promise<string | null> {
  const code = (await jsonObject(response))?.code;
  return typeof code === 'string' ? code : null;
}

function noAnswer(error: unknown, timeoutMs: number): string {
  return error instanceof TimedOut
    ? `The requesting app did not answer within ${seconds(timeoutMs)}.`
    : 'The requesting app did not answer.';
}

/**
 * Exchange the one-time nonce from the link for the session token.
 * The local app answers with the token exactly once.
 */
export async function openSession(
  nonce: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = PACKET_TIMEOUT_MS,
): Promise<SessionOpenResult> {
  let answer: { status: number; code: string | null; token: unknown };
  try {
    answer = await withTimeout(async (signal) => {
      const response = await fetchImpl(SESSION_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
        cache: 'no-store',
        signal,
      });
      const body = await jsonObject(response);
      const code = body?.code;
      return { status: response.status, code: typeof code === 'string' ? code : null, token: body?.token };
    }, timeoutMs);
  } catch (error) {
    return { ok: false, problem: 'unreachable', reason: noAnswer(error, timeoutMs) };
  }
  if (answer.status === 200 && typeof answer.token === 'string' && answer.token !== '') {
    return { ok: true, token: answer.token };
  }
  switch (answer.code) {
    case 'session-already-opened':
      return { ok: false, problem: 'already-opened', reason: 'The link was opened before.' };
    case 'session-locked':
      return { ok: false, problem: 'not-valid', reason: 'The link was tried too many times with a wrong code.' };
    case 'session-finished':
      return { ok: false, problem: 'not-valid', reason: 'The request is already finished.' };
    case 'invalid-nonce':
      return { ok: false, problem: 'not-valid', reason: 'The requesting app does not recognise this link.' };
    default:
      return { ok: false, problem: 'not-valid', reason: 'No app is waiting for a signature at this address.' };
  }
}

/** Ask the local app for the packet. Any answer but the exact contract means "no session". */
export async function fetchSessionPacket(
  token: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = PACKET_TIMEOUT_MS,
): Promise<SessionPacketResult> {
  let answer: { status: number; json: boolean; packetText: string; code: string | null };
  try {
    // The limit covers the body too: a packet carries the whole PDF.
    answer = await withTimeout(async (signal) => {
      const response = await fetchImpl(PACKET_PATH, {
        method: 'GET',
        headers: bearer(token),
        cache: 'no-store',
        signal,
      });
      const json = isJson(response);
      if (response.status === 200) {
        return { status: 200, json, packetText: json ? await response.text() : '', code: null };
      }
      return { status: response.status, json, packetText: '', code: await errorCode(response) };
    }, timeoutMs);
  } catch (error) {
    return { active: false, problem: 'unreachable', reason: noAnswer(error, timeoutMs) };
  }
  if (answer.status !== 200) {
    if (answer.code === 'session-finished') {
      return { active: false, problem: 'not-valid', reason: 'The request is already finished.' };
    }
    return {
      active: false,
      problem: 'not-valid',
      reason: `The requesting app answered with status ${answer.status}.`,
    };
  }
  if (answer.json) {
    try {
      const body: unknown = JSON.parse(answer.packetText);
      if (typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === PACKET_KIND) {
        return { active: true, packetText: answer.packetText };
      }
    } catch {
      // fall through: not JSON after all
    }
  }
  return { active: false, problem: 'not-valid', reason: 'The requesting app did not send a packet.' };
}

/** `code` is the local app's stable error code, when it sent one. */
export type PostResult = { ok: true } | { ok: false; error: string; code?: string; status?: number };

/** What each error code of the local app means, in words for the person signing. */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  'not-a-pdf': 'The requesting app could not read the signed PDF.',
  'unchanged-document': 'The requesting app received the original document, with nothing signed in it.',
  'no-audit-record': 'The requesting app found no signing record inside the PDF.',
  'wrong-document': 'The requesting app is waiting for a different document.',
  'wrong-request': 'The requesting app is waiting for a different signature request.',
  'incomplete-audit-record': 'The signing record inside the PDF does not cover every field that had to be filled.',
  'missing-signature': 'The signing record inside the PDF has no entry for a required signature or initials.',
  'missing-signer-pass': 'The signing record inside the PDF does not have a turn for every signer, in order.',
  'unchanged-page': 'A page that needed a signature arrived with nothing drawn on it.',
  'save-failed': 'The requesting app accepted the signed PDF but could not save it. It is still waiting.',
  'session-finished': 'The requesting app already closed this request: it was finished, cancelled or ran out of time.',
  'wrong-signer': 'The requesting app was not waiting for this signer to hand over.',
  'body-too-large': 'The signed PDF is larger than the requesting app accepts.',
  'bad-request': 'The signed PDF did not arrive complete.',
  unauthorized: 'The requesting app did not accept this page.',
  forbidden: 'The requesting app did not accept this page.',
};

async function post(
  path: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  timeoutMs: number = POST_TIMEOUT_MS,
): Promise<PostResult> {
  try {
    return await withTimeout(async (signal): Promise<PostResult> => {
      const response = await fetchImpl(path, { ...init, method: 'POST', cache: 'no-store', signal });
      if (response.ok) return { ok: true };
      const code = await errorCode(response);
      if (code === null) {
        return { ok: false, status: response.status, error: `The requesting app answered with status ${response.status}.` };
      }
      return {
        ok: false,
        status: response.status,
        code,
        error: ERROR_TEXT[code] ?? `The requesting app answered with status ${response.status} (${code}).`,
      };
    }, timeoutMs);
  } catch (error) {
    if (error instanceof TimedOut) {
      return { ok: false, error: `The requesting app did not answer within ${seconds(timeoutMs)}.` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `The requesting app could not be reached (${detail}).` };
  }
}

/** Send the signed PDF back to the local app. Calling it again re-posts the same bytes. */
export function postSigned(
  token: string,
  pdf: Uint8Array,
  sha256: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs?: number,
): Promise<PostResult> {
  return post(
    SIGNED_PATH,
    {
      headers: {
        ...bearer(token),
        'Content-Type': 'application/pdf',
        'X-Sign-Pdf-Sha256': sha256,
      },
      // A Blob body sends exactly these bytes, whatever buffer the view sits on.
      body: new Blob([pdf.slice()], { type: 'application/pdf' }),
    },
    fetchImpl,
    timeoutMs,
  );
}

/** Tell the local app the human declined to sign. */
export function postDeclined(
  token: string,
  reason: string,
  fetchImpl: FetchLike = fetch,
): Promise<PostResult> {
  return post(
    DECLINED_PATH,
    {
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() }),
    },
    fetchImpl,
  );
}

/**
 * Tell the local app that `signerId` finished their turn and downloaded the
 * hand-off PDF for the next signer. The body is exactly { signerId }.
 */
export function postHandedOff(token: string, signerId: string, fetchImpl: FetchLike = fetch): Promise<PostResult> {
  return post(
    HANDED_OFF_PATH,
    {
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ signerId }),
    },
    fetchImpl,
  );
}
