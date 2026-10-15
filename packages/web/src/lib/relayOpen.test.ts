// @vitest-environment node
// Node's WebCrypto, the same API the browser has; jsdom has no crypto.subtle.
import { describe, expect, it, vi } from 'vitest';
import type { RelayClient } from './relayClient.ts';
import { decryptBlob, deriveDocKey, encryptBlob, generateDocId, generateKey, keyFromFragment, keyToFragment } from './relayCrypto.ts';
import { decryptRelayHandoff, sendRelayFinal } from './relayOpen.ts';

const plaintext = new TextEncoder().encode('{"kind":"sign-pdf-packet"}');

async function sealed(password?: string) {
  const id = generateDocId();
  const raw = generateKey();
  const blob = await encryptBlob(await deriveDocKey(raw, id, password), id, 'handoff', plaintext);
  return { id, key: keyToFragment(raw), blob };
}

describe('decryptRelayHandoff', () => {
  it('opens with the right password and gives the same key for the final', async () => {
    const { id, key, blob } = await sealed('secret');
    const opened = await decryptRelayHandoff(id, key, blob, 'secret');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.plaintext).toEqual(plaintext);
    const final = await encryptBlob(opened.docKey, id, 'final', new Uint8Array([1, 2, 3]));
    const again = await deriveDocKey(keyFromFragment(key)!, id, 'secret');
    expect(await decryptBlob(again, id, 'final', final)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('gives one code for a wrong password and for a changed blob, and another for a non-blob', async () => {
    const { id, key, blob } = await sealed('secret');
    const wrong = await decryptRelayHandoff(id, key, blob, 'other');
    expect(wrong).toEqual({ ok: false, code: 'relay-decrypt-failed', message: 'Could not open. Check the password.' });
    const changed = blob.slice();
    changed[changed.length - 1]! ^= 1;
    expect(await decryptRelayHandoff(id, key, changed, 'secret')).toMatchObject({ code: 'relay-decrypt-failed' });
    expect(await decryptRelayHandoff(id, key, new Uint8Array([1, 2, 3]), 'secret')).toMatchObject({
      code: 'relay-blob-format',
    });
  });
});

describe('sendRelayFinal', () => {
  it('uploads a final blob that opens with the document key', async () => {
    const id = generateDocId();
    const docKey = await deriveDocKey(generateKey(), id);
    const uploadFinal = vi.fn<RelayClient['uploadFinal']>(() => Promise.resolve({ ok: true, value: null }));
    const client = { uploadFinal } as unknown as RelayClient;
    expect(await sendRelayFinal(client, { id, docKey, requester: 'Signer One' }, new Uint8Array([7]))).toEqual({ ok: true });
    const [sentId, blob] = uploadFinal.mock.calls[0]!;
    expect(sentId).toBe(id);
    expect(await decryptBlob(docKey, id, 'final', blob)).toEqual(new Uint8Array([7]));
  });
});
