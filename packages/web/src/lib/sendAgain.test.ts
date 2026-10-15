// @vitest-environment node
// Node's WebCrypto, the same API the browser has; jsdom has no crypto.subtle.
import { describe, expect, it } from 'vitest';
import { removeRelayEntry } from './relayStore.ts';
import { prepareHandoff } from './relaySend.ts';
import { keptNeedsPassword, openKeptHandoff } from './sendAgain.ts';
import type { SentHandoff } from './sentStore.ts';

const PACKET = '{"kind":"sign-pdf-packet","note":"synthetic"}\n';
const NOW = Date.parse('2026-10-08T12:00:00Z');
const EXP = '2026-10-15T12:00:00.000Z';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
  };
}

/** Encrypt as the email flow does, and keep the key as the sign view does. */
async function kept(password?: string) {
  const result = await prepareHandoff(PACKET, 'b@example.com', password);
  if (!result.ok) throw new Error('too large');
  const { id, key, blob } = result.prepared;
  const storage = memoryStorage();
  storage.setItem(`sign-pdf.relay.${id}`, JSON.stringify({ k: key, p: password !== undefined, exp: EXP, to: 'b@example.com' }));
  const entry: Pick<SentHandoff, 'id' | 'blob'> = { id, blob };
  return { entry, storage };
}

describe('open a kept hand-off', () => {
  it('decrypts the kept ciphertext with the kept key, the way the next signer does', async () => {
    const { entry, storage } = await kept();
    expect(new TextDecoder().decode(entry.blob)).not.toContain('sign-pdf-packet');
    const opened = await openKeptHandoff(entry, storage, undefined, NOW);
    expect(opened.ok && new TextDecoder().decode(opened.packet)).toBe(PACKET);
    // Still opens after the link expired, within the keep time.
    expect((await openKeptHandoff(entry, storage, undefined, Date.parse(EXP) + 60_000)).ok).toBe(true);
  });

  it('needs the password the first signer set', async () => {
    const { entry, storage } = await kept('pässword');
    expect(keptNeedsPassword(entry, storage, NOW)).toBe(true);
    expect(await openKeptHandoff(entry, storage, undefined, NOW)).toMatchObject({ ok: false, code: 'relay-decrypt-failed' });
    expect(await openKeptHandoff(entry, storage, 'wrong', NOW)).toMatchObject({ ok: false, code: 'relay-decrypt-failed' });
    expect((await openKeptHandoff(entry, storage, 'pässword', NOW)).ok).toBe(true);
  });

  it('cannot open a copy whose key is gone', async () => {
    const { entry, storage } = await kept();
    removeRelayEntry(storage, entry.id);
    expect(await openKeptHandoff(entry, storage, undefined, NOW)).toMatchObject({ ok: false, code: 'relay-key-missing' });
  });

  it('refuses a copy bound to another id', async () => {
    const one = await kept();
    const two = await kept();
    // The key of one, the blob of two: the AAD binds each blob to its id.
    const mixed = { id: one.entry.id, blob: two.entry.blob };
    expect((await openKeptHandoff(mixed, one.storage, undefined, NOW)).ok).toBe(false);
  });
});
