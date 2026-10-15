// @vitest-environment node
// Node's WebCrypto, the same API the browser has; jsdom has no crypto.subtle.
import { RELAY_MAX_BLOB_BYTES, RelayDocId } from '@sign-pdf/spec';
import { describe, expect, it, vi } from 'vitest';
import type { RelayClient, RelaySession } from './relayClient.ts';
import { decryptBlob, deriveDocKey, keyFromFragment, unwrapKey } from './relayCrypto.ts';
import { deliverHandoff, prepareHandoff } from './relaySend.ts';

const SESSION: RelaySession = { session: 's', expiresAt: '2026-10-08T12:00:00.000Z' };
const EXPIRES = '2026-10-14T12:00:00.000Z';
const PACKET = '{"kind":"sign-pdf-packet","note":"synthetic"}\n';

function storage() {
  const items = new Map<string, string>();
  return {
    items,
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
  };
}

function fakeClient(overrides: Partial<RelayClient> = {}): RelayClient {
  return {
    config: vi.fn(() => Promise.resolve({ ok: true as const, value: { turnstileSiteKey: '' } })),
    login: vi.fn(() => Promise.resolve({ ok: true as const, value: null })),
    verify: vi.fn(() => Promise.resolve({ ok: true as const, value: SESSION })),
    uploadHandoff: vi.fn((_session, input) => Promise.resolve({ ok: true as const, value: { id: input.id, expiresAt: EXPIRES } })),
    send: vi.fn(() => Promise.resolve({ ok: true as const, value: null })),
    fetchHandoff: vi.fn(() => Promise.reject(new Error('fetchHandoff was not expected'))),
    uploadFinal: vi.fn(() => Promise.reject(new Error('uploadFinal was not expected'))),
    fetchFinal: vi.fn(() => Promise.reject(new Error('fetchFinal was not expected'))),
    deleteDoc: vi.fn(() => Promise.reject(new Error('deleteDoc was not expected'))),
    currentSession: () => SESSION,
    clearSession: () => undefined,
    ...overrides,
  };
}

describe('prepareHandoff', () => {
  it('encrypts the packet for a new id, so the link key and the password open it', async () => {
    const result = await prepareHandoff(PACKET, 'b@example.com', 'correct horse');
    if (!result.ok) throw new Error('too large');
    const { id, key, blob, password } = result.prepared;
    expect(RelayDocId.safeParse(id).success).toBe(true);
    expect(password).toBe(true);
    expect(new TextDecoder().decode(blob)).not.toContain('sign-pdf-packet');
    const docKey = await deriveDocKey(keyFromFragment(key)!, id, 'correct horse');
    expect(new TextDecoder().decode(await decryptBlob(docKey, id, 'handoff', blob))).toBe(PACKET);
    await expect(decryptBlob(await deriveDocKey(keyFromFragment(key)!, id), id, 'handoff', blob)).rejects.toThrow();
  });

  it('wraps the key with the passphrase, and wraps nothing without one', async () => {
    const result = await prepareHandoff(PACKET, 'b@example.com', 'correct horse');
    if (!result.ok) throw new Error('too large');
    const { id, key, wrappedKey } = result.prepared;
    expect(wrappedKey).toMatch(/^[A-Za-z0-9_-]{80}$/);
    expect(await unwrapKey(wrappedKey!, id, 'correct horse')).toEqual(keyFromFragment(key));
    const plain = await prepareHandoff(PACKET, 'b@example.com');
    if (!plain.ok) throw new Error('too large');
    expect(plain.prepared).not.toHaveProperty('wrappedKey');
  });

  it('refuses a passphrase under 8 characters', async () => {
    await expect(prepareHandoff(PACKET, 'b@example.com', 'short77')).rejects.toThrow(TypeError);
  });

  it('refuses a blob over the relay cap', async () => {
    const result = await prepareHandoff('x'.repeat(RELAY_MAX_BLOB_BYTES), 'b@example.com');
    expect(result).toMatchObject({ ok: false, tooLarge: true });
  });
});

describe('deliverHandoff', () => {
  it('uploads, sends, then keeps the key on this device', async () => {
    const prepared = await prepareHandoff(PACKET, 'b@example.com');
    if (!prepared.ok) throw new Error('too large');
    const client = fakeClient();
    const store = storage();
    const result = await deliverHandoff(client, SESSION, prepared.prepared, store);
    expect(result).toEqual({ ok: true, id: prepared.prepared.id, expiresAt: EXPIRES, stored: true });
    expect(client.send).toHaveBeenCalledWith(SESSION, prepared.prepared.id, prepared.prepared.key, undefined);
    expect(JSON.parse(store.items.get(`sign-pdf.relay.${prepared.prepared.id}`)!)).toEqual({
      k: prepared.prepared.key,
      p: false,
      exp: EXPIRES,
      to: 'b@example.com',
    });
  });

  it('sends the wrapped key with the key when a passphrase was set', async () => {
    const prepared = await prepareHandoff(PACKET, 'b@example.com', 'correct horse');
    if (!prepared.ok) throw new Error('too large');
    const client = fakeClient();
    await deliverHandoff(client, SESSION, prepared.prepared, storage());
    const { id, key, wrappedKey } = prepared.prepared;
    expect(client.send).toHaveBeenCalledWith(SESSION, id, key, wrappedKey);
  });

  it('keeps nothing when the send fails, and a retry sends without uploading again', async () => {
    const prepared = await prepareHandoff(PACKET, 'b@example.com');
    if (!prepared.ok) throw new Error('too large');
    const send = vi
      .fn<RelayClient['send']>()
      .mockResolvedValueOnce({ ok: false, code: 'email-failed', status: 502, error: 'x' })
      .mockResolvedValueOnce({ ok: false, code: 'already-sent', status: 409, error: 'x' });
    const client = fakeClient({ send });
    const store = storage();
    const failed = await deliverHandoff(client, SESSION, prepared.prepared, store);
    expect(failed).toMatchObject({ ok: false, code: 'email-failed', step: 'send' });
    expect(store.items.size).toBe(0);
    // The answer to the first try was lost but the email went: 409 already-sent counts as sent.
    const again = await deliverHandoff(client, SESSION, prepared.prepared, store);
    expect(again).toMatchObject({ ok: true });
    expect(client.uploadHandoff).toHaveBeenCalledTimes(1);
    expect(store.items.size).toBe(1);
  });

  it('does not count a send that is still running as sent', async () => {
    const prepared = await prepareHandoff(PACKET, 'b@example.com');
    if (!prepared.ok) throw new Error('too large');
    const client = fakeClient({
      send: vi.fn(() => Promise.resolve({ ok: false as const, code: 'send-pending' as const, status: 409, error: 'x' })),
    });
    const store = storage();
    expect(await deliverHandoff(client, SESSION, prepared.prepared, store)).toMatchObject({ ok: false, code: 'send-pending' });
    expect(store.items.size).toBe(0);
  });

  it('stops at a failed upload without sending the key', async () => {
    const prepared = await prepareHandoff(PACKET, 'b@example.com');
    if (!prepared.ok) throw new Error('too large');
    const client = fakeClient({
      uploadHandoff: vi.fn(() => Promise.resolve({ ok: false as const, code: 'too-large' as const, status: 413, error: 'x' })),
    });
    const store = storage();
    expect(await deliverHandoff(client, SESSION, prepared.prepared, store)).toMatchObject({ ok: false, step: 'upload' });
    expect(client.send).not.toHaveBeenCalled();
    expect(store.items.size).toBe(0);
  });
});
