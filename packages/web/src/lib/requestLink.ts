/**
 * A request in the link (issue #45): an agent hands the human
 *
 *   https://sign.silv.app/#request=<request JSON, percent-encoded or base64url>
 *
 * and the request is put on the page once the human opens the PDF it was
 * written for. The fragment never reaches a server. It is read once at
 * start-up and taken out of the address bar, so a reload does not apply it
 * again. Only JSON.parse reads it here; the core validates it against the PDF
 * before anything shows (agent/api.ts, apply_request), and a request written
 * for another PDF fails with hash-mismatch.
 */

/** Longest fragment value accepted, in characters. */
export const MAX_REQUEST_LINK_CHARS = 32 * 1024;

const PREFIX = 'request=';

export type RequestLink = { ok: true; request: Record<string, unknown> } | { ok: false; error: string };

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** The request in a fragment, null when the fragment has none. */
export function parseRequestLink(hash: string): RequestLink | null {
  const fragment = hash.replace(/^#/, '');
  if (!fragment.startsWith(PREFIX)) return null;
  const value = fragment.slice(PREFIX.length);
  if (value.length > MAX_REQUEST_LINK_CHARS) {
    return { ok: false, error: 'The request in the link is too long. Ask for a packet file or paste the request instead.' };
  }
  let parsed: unknown;
  try {
    // Base64url never starts with a JSON bracket, so the first character tells the two apart.
    const decoded = decodeURIComponent(value);
    parsed = JSON.parse(/^\s*[[{]/.test(decoded) ? decoded : decodeBase64Url(value));
  } catch {
    return { ok: false, error: 'The request in the link could not be read.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'The request in the link is not a JSON object.' };
  }
  return { ok: true, request: parsed as Record<string, unknown> };
}

/** Read the request in the address, and take it out of the address bar and this history entry. */
export function readRequestLink(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  history: Pick<History, 'replaceState' | 'state'>,
): RequestLink | null {
  const link = parseRequestLink(location.hash);
  if (link) history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  return link;
}
