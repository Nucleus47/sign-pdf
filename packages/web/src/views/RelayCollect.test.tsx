/**
 * The first signer collects the signed PDF from the return link (issue #71):
 * the code card, the card for a device without the key (code and passphrase), and the downloaded
 * screen. The relay client is a fake; the relay crypto is replaced (jsdom has
 * no crypto.subtle; lib/relayCollect.test.ts covers it).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import { setRelayClient, type RelayClient } from '../lib/relayClient.ts';

const crypto = vi.hoisted(() => ({
  password: undefined as string | undefined,
  derive: [] as (string | undefined)[],
  unwrap: [] as string[],
}));

vi.mock('../lib/relayCrypto.ts', async (importActual) => {
  const actual = await importActual<typeof import('../lib/relayCrypto.ts')>();
  return {
    ...actual,
    deriveDocKey: (_key: Uint8Array, _id: string, password?: string) => {
      crypto.derive.push(password);
      return Promise.resolve({ password } as unknown as CryptoKey);
    },
    decryptBlob: (docKey: { password?: string }, _id: string, purpose: string) =>
      purpose === 'final' && docKey.password === crypto.password
        ? Promise.resolve(PDF)
        : Promise.reject(new actual.RelayCryptoError('relay-decrypt-failed', 'x')),
    // The passphrase that wraps the key is the one that went into the document key.
    unwrapKey: (wrapped: string, _id: string, passphrase: string) => {
      crypto.unwrap.push(passphrase);
      return wrapped === WRAPPED && passphrase === crypto.password
        ? Promise.resolve(actual.keyFromFragment(KEY)!)
        : Promise.reject(new actual.RelayCryptoError('relay-unwrap-failed', 'x'));
    },
  };
});

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const BLOB = new Uint8Array([0x53, 0x50, 0x52, 0x31]);
const WRAPPED = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7';

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, String(value)),
    removeItem: (name: string) => void items.delete(name),
  };
}

let storage: Storage;
let restore: (() => void) | undefined;
let click: ReturnType<typeof vi.spyOn>;
let names: string[];

function relay(overrides: Partial<RelayClient> = {}) {
  const notUsed = () => Promise.reject(new Error('not expected'));
  const client = {
    config: notUsed,
    login: notUsed,
    verify: notUsed,
    uploadHandoff: notUsed,
    send: notUsed,
    fetchHandoff: notUsed,
    uploadFinal: notUsed,
    fetchFinal: vi.fn<RelayClient['fetchFinal']>(() => Promise.resolve({ ok: true, value: { blob: BLOB } })),
    deleteDoc: vi.fn<RelayClient['deleteDoc']>(() => Promise.resolve({ ok: true, value: null })),
    currentSession: () => null,
    clearSession: () => undefined,
    ...overrides,
  };
  restore = setRelayClient(client as RelayClient);
  return client;
}

function keep(entry: Record<string, unknown> = {}) {
  storage.setItem(
    `sign-pdf.relay.${ID}`,
    JSON.stringify({ k: KEY, p: false, exp: '2099-01-01T00:00:00.000Z', to: 'b@example.com', n: 'agreement-signed.pdf', ...entry }),
  );
}

const mount = () => render(<App sessionNonce={null} relayLink={{ id: ID, password: false }} />);

beforeEach(() => {
  crypto.password = undefined;
  crypto.derive = [];
  crypto.unwrap = [];
  storage = memoryStorage();
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  URL.createObjectURL = vi.fn(() => 'blob:signed');
  URL.revokeObjectURL = vi.fn();
  names = [];
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in this test'))));
});

afterEach(() => {
  restore?.();
  restore = undefined;
  click.mockRestore();
  vi.unstubAllGlobals();
});

describe('collect the signed PDF', () => {
  it('shows the code card and fetches nothing before the code is submitted', async () => {
    keep();
    const client = relay();
    mount();
    expect(screen.getByTestId('relay-collect')).toHaveTextContent('Your signed document is ready');
    expect(screen.getByText('The code is in the email.')).toBeInTheDocument();
    expect(screen.queryByTestId('relay-collect-password')).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('relay-collect-code'), '12345');
    expect(client.fetchFinal).not.toHaveBeenCalled();
    // A short code is caught here, without using an attempt.
    await user.click(screen.getByTestId('relay-collect-button'));
    expect(screen.getByTestId('relay-collect-error')).toHaveTextContent('Enter the 6-digit code from the email.');
    expect(client.fetchFinal).not.toHaveBeenCalled();
    expect(client.deleteDoc).not.toHaveBeenCalled();
  });

  it('downloads with the code, then deletes the server copy and the kept key', async () => {
    keep();
    const client = relay();
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('relay-collect-code'), '123456');
    await user.click(screen.getByTestId('relay-collect-button'));
    expect(await screen.findByTestId('relay-collect-done')).toHaveTextContent('The copy on the server is deleted.');
    expect(client.fetchFinal).toHaveBeenCalledWith(ID, '123456');
    expect(names).toEqual(['agreement-signed.pdf']);
    expect(client.deleteDoc).toHaveBeenCalledWith(ID);
    expect(storage.getItem(`sign-pdf.relay.${ID}`)).toBeNull();
    expect(crypto.derive).toEqual([undefined]);
    expect(screen.getByTestId('relay-collect-status')).toHaveTextContent('The copy on the server is deleted.');
    // From memory: no request.
    await user.click(screen.getByTestId('relay-collect-again'));
    expect(names).toEqual(['agreement-signed.pdf', 'agreement-signed.pdf']);
    expect(client.fetchFinal).toHaveBeenCalledTimes(1);
  });

  it('asks for the password on the same card and retries it without a new code attempt', async () => {
    crypto.password = 'secret';
    keep({ p: true, n: undefined });
    const client = relay();
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('relay-collect-code'), '123456');
    await user.type(screen.getByTestId('relay-collect-password'), 'wrong');
    await user.click(screen.getByTestId('relay-collect-button'));
    expect(await screen.findByTestId('relay-collect-error')).toHaveTextContent('Check the password.');
    expect(client.deleteDoc).not.toHaveBeenCalled();
    await user.clear(screen.getByTestId('relay-collect-password'));
    await user.type(screen.getByTestId('relay-collect-password'), 'secret');
    await user.click(screen.getByTestId('relay-collect-button'));
    await screen.findByTestId('relay-collect-done');
    expect(client.fetchFinal).toHaveBeenCalledTimes(1);
    expect(names).toEqual(['signed.pdf']);
    expect(client.deleteDoc).toHaveBeenCalledTimes(1);
  });

  it('says a wrong code is wrong and an expired document is gone, and deletes nothing', async () => {
    keep();
    const client = relay({
      fetchFinal: vi
        .fn<RelayClient['fetchFinal']>()
        .mockResolvedValueOnce({ ok: false, code: 'bad-code', error: 'x', status: 401 })
        .mockResolvedValueOnce({ ok: false, code: 'not-found', error: 'x', status: 404 }),
    });
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('relay-collect-code'), '000000');
    await user.click(screen.getByTestId('relay-collect-button'));
    expect(await screen.findByTestId('relay-collect-error')).toHaveTextContent(/^Wrong code\./);
    expect(screen.getByTestId('relay-collect-code')).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByTestId('relay-collect-button'));
    expect(await screen.findByText(/no longer on the server/)).toBeInTheDocument();
    expect(client.deleteDoc).not.toHaveBeenCalled();
    expect(names).toEqual([]);
    expect(storage.getItem(`sign-pdf.relay.${ID}`)).not.toBeNull();
  });

  it('takes a pasted code with a space, and says so when the server copy could not be deleted', async () => {
    keep();
    const client = relay({ deleteDoc: vi.fn<RelayClient['deleteDoc']>(() => Promise.resolve({ ok: false, code: 'unreachable', error: 'x' })) });
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('relay-collect-code'));
    await user.paste('123 456');
    await user.click(screen.getByTestId('relay-collect-button'));
    expect(await screen.findByTestId('relay-collect-status')).toHaveTextContent('could not be deleted now');
    expect(client.fetchFinal).toHaveBeenCalledWith(ID, '123456');
    expect(names).toEqual(['agreement-signed.pdf']);
    expect(storage.getItem(`sign-pdf.relay.${ID}`)).toBeNull();
  });

  describe('on a device without the kept key (issue #105)', () => {
    const withWrappedKey = () =>
      relay({ fetchFinal: vi.fn<RelayClient['fetchFinal']>(() => Promise.resolve({ ok: true, value: { blob: BLOB, wrappedKey: WRAPPED } })) });

    it('asks for the code and the passphrase, and fetches nothing before both are there', async () => {
      const client = withWrappedKey();
      mount();
      expect(screen.getByTestId('relay-collect')).toHaveTextContent('Your signed document is ready');
      expect(screen.getByText('The passphrase you set when you sent it. A wrong passphrase does not use a code attempt.')).toBeInTheDocument();
      expect(screen.getByTestId('relay-collect-nopass')).toHaveTextContent('ask the other signer for the PDF');
      const user = userEvent.setup();
      await user.type(screen.getByTestId('relay-collect-code'), '123456');
      await user.click(screen.getByTestId('relay-collect-button'));
      expect(screen.getByTestId('relay-collect-error')).toHaveTextContent('Enter the passphrase.');
      expect(client.fetchFinal).not.toHaveBeenCalled();
    });

    it('unwraps the key with the passphrase, downloads, then deletes the server copy', async () => {
      crypto.password = 'correct horse';
      const client = withWrappedKey();
      mount();
      const user = userEvent.setup();
      await user.type(screen.getByTestId('relay-collect-code'), '123456');
      await user.type(screen.getByTestId('relay-collect-password'), 'correct horse');
      await user.click(screen.getByTestId('relay-collect-button'));
      expect(await screen.findByTestId('relay-collect-done')).toHaveTextContent('The copy on the server is deleted.');
      expect(client.fetchFinal).toHaveBeenCalledWith(ID, '123456');
      expect(crypto.unwrap).toEqual(['correct horse']);
      expect(crypto.derive).toEqual(['correct horse']);
      expect(names).toEqual(['signed.pdf']);
      expect(client.deleteDoc).toHaveBeenCalledWith(ID);
    });

    it('says a wrong passphrase is wrong and retries it without a new code attempt', async () => {
      crypto.password = 'correct horse';
      const client = withWrappedKey();
      mount();
      const user = userEvent.setup();
      await user.type(screen.getByTestId('relay-collect-code'), '123456');
      await user.type(screen.getByTestId('relay-collect-password'), 'wrong horse');
      await user.click(screen.getByTestId('relay-collect-button'));
      expect(await screen.findByTestId('relay-collect-error')).toHaveTextContent(/^Wrong passphrase\..*does not use a code attempt/);
      expect(screen.getByTestId('relay-collect-password')).toHaveAttribute('aria-invalid', 'true');
      // The code is spent once; the field is gone.
      expect(screen.queryByTestId('relay-collect-code')).toBeNull();
      expect(client.deleteDoc).not.toHaveBeenCalled();
      await user.clear(screen.getByTestId('relay-collect-password'));
      await user.type(screen.getByTestId('relay-collect-password'), 'correct horse');
      await user.click(screen.getByTestId('relay-collect-button'));
      await screen.findByTestId('relay-collect-done');
      expect(client.fetchFinal).toHaveBeenCalledTimes(1);
      expect(crypto.unwrap).toEqual(['wrong horse', 'correct horse']);
      expect(client.deleteDoc).toHaveBeenCalledTimes(1);
    });

    it('says to use the sending device or ask the other signer when there is no wrapped key', async () => {
      const client = relay();
      mount();
      const user = userEvent.setup();
      await user.type(screen.getByTestId('relay-collect-code'), '123456');
      await user.type(screen.getByTestId('relay-collect-password'), 'anything at all');
      await user.click(screen.getByTestId('relay-collect-button'));
      expect(await screen.findByTestId('relay-collect-nokey')).toHaveTextContent(
        'Open this link there, or ask the other signer for the PDF; they downloaded a copy.',
      );
      expect(crypto.unwrap).toEqual([]);
      expect(client.deleteDoc).not.toHaveBeenCalled();
      expect(names).toEqual([]);
    });
  });

  it('treats an expired kept entry as no key: it asks for the passphrase', () => {
    keep({ exp: '2000-01-01T00:00:00.000Z' });
    relay();
    mount();
    expect(screen.getByTestId('relay-collect-password')).toBeInTheDocument();
    expect(screen.getByTestId('relay-collect-nopass')).toBeInTheDocument();
  });
});
