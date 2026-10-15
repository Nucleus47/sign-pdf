/** Response helpers shared by every /relay handler. */

/** Headers on every /relay response; the assets' _headers file does not cover them. */
export const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export type ErrorCode =
  | 'bad-request'
  | 'bad-code'
  | 'unauthorized'
  | 'not-found'
  | 'too-large'
  | 'rate-limited'
  | 'already-sent'
  | 'id-taken'
  | 'send-pending'
  | 'final-exists'
  | 'email-failed'
  | 'bad-wrapped-key'
  | 'server-error';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...NO_STORE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function jsonError(status: number, code: ErrorCode, error: string): Response {
  return json({ error, code }, status);
}

/** A handler throws this to stop with an error response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (): HttpError => new HttpError(404, 'not-found', 'Not found.');
export const badRequest = (message = 'The request is not valid.'): HttpError =>
  new HttpError(400, 'bad-request', message);
export const rateLimited = (): HttpError =>
  new HttpError(429, 'rate-limited', 'Too many requests. Wait a minute and try again.');
export const unauthorized = (): HttpError =>
  new HttpError(401, 'unauthorized', 'Sign in again.');

/** Largest JSON body any /relay route accepts. */
const MAX_JSON_BYTES = 8 * 1024;

/** Reads a small JSON body, stopping past the cap; anything unreadable is a 400. */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (!(declared <= MAX_JSON_BYTES) || !request.body) throw badRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw badRequest();
      }
      chunks.push(value);
    }
  } catch {
    throw badRequest();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw badRequest();
  }
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
