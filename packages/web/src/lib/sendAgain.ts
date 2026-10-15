/**
 * Open a kept hand-off to send it again (issue #98). The device keeps only
 * the ciphertext (sentStore.ts) and the key (relayStore.ts); this decrypts it
 * in memory, the same way the next signer's browser does (relayOpen.ts), and
 * builds the hand-off PDF from the packet the way the sign view does.
 */
import { core } from './core.ts';
import { decryptRelayHandoff, RELAY_DECRYPT_TEXT } from './relayOpen.ts';
import { loadRelayEntry } from './relayStore.ts';
import type { SentHandoff } from './sentStore.ts';

export type OpenKeptResult =
  | { ok: true; packet: Uint8Array }
  | { ok: false; code: 'relay-key-missing' | 'relay-decrypt-failed' | 'relay-blob-format'; message: string };

/** True when the kept copy needs the password the first signer set. */
export function keptNeedsPassword(entry: Pick<SentHandoff, 'id'>, relayStorage: Parameters<typeof loadRelayEntry>[0], now = Date.now()): boolean {
  return loadRelayEntry(relayStorage, entry.id, now, { afterExpiry: true })?.p ?? false;
}

/** Decrypt the kept copy with the key this device kept for its relay id. */
export async function openKeptHandoff(
  entry: Pick<SentHandoff, 'id' | 'blob'>,
  relayStorage: Parameters<typeof loadRelayEntry>[0],
  password: string | undefined,
  now: number = Date.now(),
): Promise<OpenKeptResult> {
  const kept = loadRelayEntry(relayStorage, entry.id, now, { afterExpiry: true });
  if (!kept) {
    return {
      ok: false,
      code: 'relay-key-missing',
      message: 'This browser no longer has the key to open this copy. Remove it, and sign again from the start.',
    };
  }
  if (kept.p && !password) {
    return { ok: false, code: 'relay-decrypt-failed', message: RELAY_DECRYPT_TEXT['relay-decrypt-failed'] };
  }
  const opened = await decryptRelayHandoff(entry.id, kept.k, entry.blob, kept.p ? password : undefined);
  if (!opened.ok) return { ok: false, code: opened.code, message: opened.message };
  return { ok: true, packet: opened.plaintext };
}

/** The hand-off PDF for decrypted packet bytes. Throws a core error when the packet is damaged. */
export async function handoffPdfFromPacket(packet: Uint8Array): Promise<Uint8Array> {
  const contents = await core.decodeHandoff(packet);
  const resolved = await core.resolveRequest(contents.pdf, contents.packet.request);
  const result = await core.buildHandoffPdf(contents.pdf, resolved, contents.passes);
  return result.pdf;
}
