/**
 * Relay links (issue #65). The next signer's email carries
 *
 *   …/#relay=<id>&k=<key>[&p=1]     id: 22 base64url characters; key: 43; p=1 when a password is set
 *
 * and the first signer's return link carries only `#relay=<id>` (their device
 * kept the key). The fragment never reaches a server. The page reads it once
 * at start-up and takes it out of the address bar and the history entry
 * before anything else runs, the same as a loopback `session=` nonce
 * (lib/transport.ts). Reading a link makes no request.
 */
import { RelayDocId, RelayKey } from '@sign-pdf/spec';

export interface RelayLink {
  id: string;
  /** The key's 43 base64url characters; absent in the first signer's return link. */
  key?: string;
  /** True when the first signer set a password (`p=1`). */
  password: boolean;
}

const RELAY_PARTS = new Set(['relay', 'k', 'p']);

function parts(hash: string): [name: string, value: string][] {
  return hash
    .replace(/^#/, '')
    .split('&')
    .filter((part) => part !== '')
    .map((part) => {
      const at = part.indexOf('=');
      return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
    });
}

/**
 * The relay link in a URL fragment, or null when there is none or it is not
 * well formed. Values are taken as written: ids and keys are base64url, which
 * needs no percent-encoding, so an encoded one is refused.
 */
export function parseRelayLink(hash: string): RelayLink | null {
  const found = new Map<string, string>();
  for (const [name, value] of parts(hash)) {
    if (!RELAY_PARTS.has(name)) continue;
    if (found.has(name)) return null;
    found.set(name, value);
  }
  const id = found.get('relay');
  if (id === undefined || !RelayDocId.safeParse(id).success) return null;
  const key = found.get('k');
  if (key !== undefined && !RelayKey.safeParse(key).success) return null;
  const p = found.get('p');
  if (p !== undefined && (p !== '1' || key === undefined)) return null;
  return key === undefined ? { id, password: false } : { id, key, password: p === '1' };
}

/** The fragment without its relay parts (`relay`, `k`, `p`); other parts are kept. */
export function hashWithoutRelay(hash: string): string {
  const rest = hash
    .replace(/^#/, '')
    .split('&')
    .filter((part) => part !== '' && !RELAY_PARTS.has(part.split('=', 1)[0] ?? ''))
    .join('&');
  return rest ? `#${rest}` : '';
}

/**
 * Read the relay link in the address and take it out of the address bar, so
 * the key is not kept in the history or copied with the address. Any fragment
 * with a `relay=` or `k=` part is stripped, even a malformed one: it can hold
 * a key. The app uses no other fragment part of those names.
 */
export function readRelayLink(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  history: Pick<History, 'replaceState' | 'state'>,
): RelayLink | null {
  if (!parts(location.hash).some(([name]) => name === 'relay' || name === 'k')) return null;
  const link = parseRelayLink(location.hash);
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hashWithoutRelay(location.hash)}`);
  return link;
}
