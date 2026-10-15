// @vitest-environment node
// Node's WebCrypto, the same API the browser has; jsdom has no crypto.subtle.
import { describe, expect, it } from 'vitest';
import { createRelayClient, type RelayClient } from './relayClient.ts';
import { decryptRelayFinal, fetchRelayFinal, unwrapRelayKey } from './relayCollect.ts';
import { deriveDocKey, encryptBlob, generateDocId, generateKey, keyToFragment, wrapKey } from './relayCrypto.ts';
import type { FetchLike } from './transport.ts';

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

async function sealedFinal(password?: string) {
  const id = generateDocId();
  const raw = generateKey();
  const blob = await encryptBlob(await deriveDocKey(raw, id, password), id, 'final', pdf);
  return { id, k: keyToFragment(raw), blob };
}

describe('decryptRelayFinal', () => {
  it('opens the final with the kept key, with and without a password', async () => {
    const plain = await sealedFinal();
    expect(await decryptRelayFinal(plain.id, plain, plain.blob, undefined)).toEqual({ ok: true, pdf });
    const locked = await sealedFinal('secret');
    expect(await decryptRelayFinal(locked.id, locked, locked.blob, 'secret')).toEqual({ ok: true, pdf });
  });

  it('says to check the password when it is wrong, and refuses a hand-off blob', async () => {
    const locked = await sealedFinal('secret');
    expect(await decryptRelayFinal(locked.id, locked, locked.blob, 'other')).toEqual({
      ok: false,
      code: 'relay-decrypt-failed',
      message: 'Could not open. Check the password.',
    });
    // A blob for the other purpose does not open as the final.
    const id = generateDocId();
    const raw = generateKey();
    const handoff = await encryptBlob(await deriveDocKey(raw, id), id, 'handoff', pdf);
    expect(await decryptRelayFinal(id, { k: keyToFragment(raw) }, handoff, undefined)).toMatchObject({
      code: 'relay-decrypt-failed',
    });
    expect(await decryptRelayFinal(id, { k: keyToFragment(raw) }, new Uint8Array([1, 2]), undefined)).toMatchObject({
      code: 'relay-blob-format',
    });
  });
});

describe('fetchRelayFinal', () => {
  const client = (result: Awaited<ReturnType<RelayClient['fetchFinal']>>) =>
    ({ fetchFinal: () => Promise.resolve(result) }) as unknown as RelayClient;

  it('words a wrong code and a gone document for the first signer', async () => {
    const wrong = await fetchRelayFinal(client({ ok: false, code: 'bad-code', error: 'x', status: 401 }), 'id', '000000');
    expect(wrong).toMatchObject({ ok: false, code: 'bad-code', status: 401 });
    if (!wrong.ok) expect(wrong.message).toMatch(/^Wrong code\./);
    const gone = await fetchRelayFinal(client({ ok: false, code: 'not-found', error: 'x', status: 404 }), 'id', '000000');
    if (!gone.ok) expect(gone.message).toMatch(/no longer on the server/);
  });
});

describe('collect on another device with the passphrase (issue #105)', () => {
  const PASS = 'correct horse';

  /** A relay that answers GET /final with the code 123456: the blob, and the wrapped key when there is one. */
  async function relayWith(options: { passphrase?: string; wrap: boolean }) {
    const id = generateDocId();
    const raw = generateKey();
    const blob = await encryptBlob(await deriveDocKey(raw, id, options.passphrase), id, 'final', pdf);
    const wrapped = options.wrap && options.passphrase ? await wrapKey(raw, id, options.passphrase) : undefined;
    const requests: { url: string; headers: Headers }[] = [];
    const fetch: FetchLike = (url, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ url, headers });
      if (headers.get('x-relay-code') !== '123456') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'x', code: 'bad-code' }), { status: 401, headers: { 'content-type': 'application/json' } }),
        );
      }
      return Promise.resolve(
        new Response(blob.slice(), {
          headers: {
            'content-type': 'application/octet-stream',
            ...(wrapped ? { 'x-relay-wrapped-key': wrapped } : {}),
          },
        }),
      );
    };
    return { id, raw, client: createRelayClient({ fetch }), requests };
  }

  it('unwraps the key and opens the signed PDF', async () => {
    const { id, raw, client, requests } = await relayWith({ passphrase: PASS, wrap: true });
    const got = await fetchRelayFinal(client, id, '123456');
    if (!got.ok || !got.wrappedKey) throw new Error('no wrapped key');
    const unwrapped = await unwrapRelayKey(id, got.wrappedKey, PASS);
    expect(unwrapped).toEqual({ ok: true, entry: { k: keyToFragment(raw) } });
    if (!unwrapped.ok) return;
    expect(await decryptRelayFinal(id, unwrapped.entry, got.blob, PASS)).toEqual({ ok: true, pdf });
    // The passphrase and the key went into no request.
    expect(requests).toHaveLength(1);
    const sent = JSON.stringify([...requests[0]!.headers]) + requests[0]!.url;
    expect(sent).not.toContain(PASS);
    expect(sent).not.toContain(keyToFragment(raw));
  });

  it('says a wrong passphrase is wrong, on this device, with no second request', async () => {
    const { id, client, requests } = await relayWith({ passphrase: PASS, wrap: true });
    const got = await fetchRelayFinal(client, id, '123456');
    if (!got.ok || !got.wrappedKey) throw new Error('no wrapped key');
    const wrong = await unwrapRelayKey(id, got.wrappedKey, 'correct horsf');
    expect(wrong).toEqual({
      ok: false,
      code: 'relay-unwrap-failed',
      message: 'Wrong passphrase. Check it, then try again. This does not use a code attempt.',
    });
    expect(requests).toHaveLength(1);
    // The same fetched copy opens with the right passphrase.
    expect(await unwrapRelayKey(id, got.wrappedKey, PASS)).toMatchObject({ ok: true });
  });

  it('gets no wrapped key when the first signer set no passphrase', async () => {
    const { id, client } = await relayWith({ wrap: false });
    const got = await fetchRelayFinal(client, id, '123456');
    expect(got).toMatchObject({ ok: true });
    expect(got).not.toHaveProperty('wrappedKey');
  });

  it('refuses a wrapped key for another document', async () => {
    const { id, client } = await relayWith({ passphrase: PASS, wrap: true });
    const got = await fetchRelayFinal(client, id, '123456');
    if (!got.ok || !got.wrappedKey) throw new Error('no wrapped key');
    expect(await unwrapRelayKey(generateDocId(), got.wrappedKey, PASS)).toMatchObject({ code: 'relay-unwrap-failed' });
  });
});
