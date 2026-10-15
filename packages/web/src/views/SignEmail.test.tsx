/**
 * "Email it" in the sign view: the next signer's address in the block of choices, the panel, the sign-in by code and
 * the sent screen, with a fake core and a fake relay client. Encryption is
 * replaced (jsdom has no crypto.subtle); lib/relaySend.test.ts covers it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo } from '@sign-pdf/spec';
import type { SignJob } from '../app/open.ts';
import { setCore, type CoreApi } from '../lib/core.ts';
import { setRelayClient, type RelayClient, type RelaySession } from '../lib/relayClient.ts';
import type { PrepareResult } from '../lib/relaySend.ts';
import { fakeCore, makeResolved, makeTwoSignerResolved, PNG_BYTES, SHA, TWO_SIGNER_FIELDS } from '../testing/fixtures.ts';
import { Sign } from './Sign.tsx';

vi.mock('../components/PdfViewer.tsx', () => ({
  PdfViewer: (props: { renderOverlay?: (page: PageInfo, scale: number) => ReactNode }) => (
    <div data-testid="viewer-stub">{props.renderOverlay?.({ page: 1, width: 612, height: 792 }, 1)}</div>
  ),
}));

vi.mock('../components/SignatureDialog.tsx', () => ({
  SignatureDialog: (props: { onDone: (result: { png: Uint8Array; method: 'typed' }) => void }) => (
    <div role="dialog" aria-label="capture stub">
      <button type="button" onClick={() => props.onDone({ png: PNG_BYTES, method: 'typed' })}>
        stub: use signature
      </button>
    </div>
  ),
}));

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const WRAPPED = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7';
const EXPIRES = '2026-10-14T12:00:00.000Z';
const SESSION: RelaySession = { session: 'payload.signature', expiresAt: '2099-01-01T00:00:00.000Z' };

const prepare = vi.hoisted(() => ({
  result: null as null | (() => PrepareResult),
  calls: [] as { packetText: string; to: string; password: string | undefined }[],
}));

vi.mock('../lib/relaySend.ts', async (importActual) => {
  const actual = await importActual<typeof import('../lib/relaySend.ts')>();
  return {
    ...actual,
    prepareHandoff: (packetText: string, to: string, password?: string) => {
      prepare.calls.push({ packetText, to, password });
      const made = prepare.result?.() ?? {
        ok: true,
        prepared: {
          id: ID,
          key: KEY,
          blob: new Uint8Array([1, 2, 3]),
          to,
          password: password !== undefined,
          ...(password !== undefined ? { wrappedKey: WRAPPED } : {}),
        },
      };
      return Promise.resolve(made);
    },
  };
});

const job: SignJob = {
  document: { name: 'agreement.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) },
  request: { version: 1, document: { name: 'agreement.pdf', sha256: SHA }, fields: [] },
  origin: 'file',
};

let restoreCore: () => void = () => undefined;
let restoreRelay: () => void = () => undefined;

function fakeRelay(signedIn: boolean, overrides: Partial<RelayClient> = {}) {
  let session: RelaySession | null = signedIn ? SESSION : null;
  const client: RelayClient = {
    config: vi.fn(() => Promise.resolve({ ok: true as const, value: { turnstileSiteKey: '' } })),
    login: vi.fn(() => Promise.resolve({ ok: true as const, value: null })),
    verify: vi.fn(() => {
      session = SESSION;
      return Promise.resolve({ ok: true as const, value: SESSION });
    }),
    uploadHandoff: vi.fn(() => Promise.resolve({ ok: true as const, value: { id: ID, expiresAt: EXPIRES } })),
    send: vi.fn(() => Promise.resolve({ ok: true as const, value: null })),
    fetchHandoff: vi.fn(() => Promise.reject(new Error('fetchHandoff was not expected'))),
    uploadFinal: vi.fn(() => Promise.reject(new Error('uploadFinal was not expected'))),
    fetchFinal: vi.fn(() => Promise.reject(new Error('fetchFinal was not expected'))),
    deleteDoc: vi.fn(() => Promise.reject(new Error('deleteDoc was not expected'))),
    currentSession: () => session,
    clearSession: () => {
      session = null;
    },
    ...overrides,
  };
  restoreRelay = setRelayClient(client);
  return client;
}

function mount(resolved = makeTwoSignerResolved()) {
  const build = vi.fn<CoreApi['buildHandoffPdf']>(() =>
    Promise.resolve({ pdf: new Uint8Array([7, 7]), packet: { kind: 'sign-pdf-packet' } as never }),
  );
  const encode = vi.fn<CoreApi['encodePacket']>(() => Promise.resolve('{"kind":"sign-pdf-packet"}\n'));
  restoreCore = setCore(
    fakeCore({ resolveRequest: () => Promise.resolve(resolved), buildHandoffPdf: build, encodePacket: encode }),
  );
  render(<Sign job={job} onDocState={() => undefined} onStartOver={() => undefined} />);
  return { build, encode };
}

/** Signer One signs their field and accepts the confirmation: the end of the turn. */
async function finishTurn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('guide-next'));
  await user.click(screen.getByText('stub: use signature'));
  await user.click(screen.getByTestId('consent'));
}

/** The next signer's address in the block of choices, then "Email it". */
async function emailTo(user: ReturnType<typeof userEvent.setup>, address: string) {
  await user.type(await screen.findByTestId('next-email'), address);
  await user.click(screen.getByTestId('email-handoff'));
}

let click: ReturnType<typeof vi.spyOn>;

/** A Storage in memory: this jsdom has none to give (opaque origin). */
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
let localStorage: Storage;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  prepare.result = null;
  prepare.calls = [];
  localStorage = memoryStorage();
  Object.defineProperty(window, 'localStorage', { value: localStorage, configurable: true });
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  restoreCore();
  restoreRelay();
  click.mockRestore();
});

describe('email the hand-off', () => {
  it('sends with a live session: encrypt, upload, send, keep the key, then the sent screen', async () => {
    const user = userEvent.setup();
    const relay = fakeRelay(true);
    const { build, encode } = mount();
    await finishTurn(user);
    // With email available it is the first choice: the next signer's address, then "Email it" under it.
    const address = await screen.findByTestId('next-email');
    expect(screen.getByLabelText("Signer Two's email")).toBe(address);
    const emailIt = screen.getByTestId('email-handoff');
    expect(emailIt).toHaveClass('primary');
    expect(emailIt).toHaveTextContent(/^Email it$/);
    expect(emailIt).toBeDisabled();
    expect(screen.getByTestId('sign-button')).toHaveTextContent('Download PDF for Signer Two');
    expect(screen.getByTestId('sign-button')).not.toHaveClass('primary');
    await user.type(address, ' B@Example.com ');
    expect(emailIt).toBeEnabled();
    await user.click(emailIt);
    expect(screen.getByTestId('email-handoff-dialog')).toHaveTextContent('Email it to Signer Two');
    expect(screen.getByTestId('email-recipient')).toHaveTextContent('tell them separately');
    // The panel shows the address typed before the tap and does not ask for it again.
    expect(screen.getByTestId('email-to-given')).toHaveTextContent('To b@example.com');
    expect(screen.queryByTestId('email-to')).toBeNull();

    await user.type(screen.getByTestId('email-password'), 'pässword');
    await user.click(screen.getByTestId('email-continue'));

    const sent = await screen.findByTestId('handoff-sent');
    expect(sent).toHaveTextContent('Sent to Signer Two');
    // The slip says until when the link works; no second sentence repeats it.
    expect(sent).not.toHaveTextContent('The link works for');
    expect(screen.getByTestId('handoff-emailed-to')).toHaveTextContent('b@example.com');
    expect(screen.getByTestId('handoff-emailed-to')).toHaveTextContent('Link works until');
    expect(screen.queryByTestId('handoff-copy-text')).toBeNull();
    expect(screen.queryByTestId('email-handoff-dialog')).toBeNull();

    expect(build).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(prepare.calls).toEqual([{ packetText: '{"kind":"sign-pdf-packet"}\n', to: 'b@example.com', password: 'pässword' }]);
    expect(relay.login).not.toHaveBeenCalled();
    expect(relay.uploadHandoff).toHaveBeenCalledWith(SESSION, {
      id: ID,
      to: 'b@example.com',
      password: true,
      blob: new Uint8Array([1, 2, 3]),
    });
    // The wrapped key goes with the send, so the first signer can collect on another device.
    expect(relay.send).toHaveBeenCalledWith(SESSION, ID, KEY, WRAPPED);
    expect(JSON.parse(localStorage.getItem(`sign-pdf.relay.${ID}`)!)).toEqual({
      k: KEY,
      p: true,
      exp: EXPIRES,
      to: 'b@example.com',
      n: 'agreement-signed.pdf',
    });
    // Nothing was downloaded; the hand-off PDF is the fallback.
    expect(click).not.toHaveBeenCalled();
    expect(screen.queryByTestId('handoff-warning')).toBeNull();
    const download = screen.getByTestId('download-handoff-again');
    expect(download).toHaveTextContent('Download the hand-off PDF instead');
    await user.click(download);
    expect(click).toHaveBeenCalledTimes(1);
    expect(download).toHaveTextContent('Download again');
    expect(screen.getByTestId('handoff-warning')).toBeInTheDocument();
  });

  it('signs in first when there is no session, and loads no Turnstile without a site key', async () => {
    const user = userEvent.setup();
    const relay = fakeRelay(false);
    mount();
    await finishTurn(user);
    await emailTo(user, 'b@example.com');
    await user.click(screen.getByTestId('email-continue'));

    expect(await screen.findByTestId('email-account')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('email-send-code')).toBeEnabled());
    expect(screen.queryByTestId('turnstile')).toBeNull();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    await user.type(screen.getByTestId('email-own'), 'A@example.com');
    await user.click(screen.getByTestId('email-send-code'));
    expect(relay.login).toHaveBeenCalledWith('a@example.com', 'none');

    expect(await screen.findByTestId('email-code')).toHaveTextContent('A@example.com');
    await user.type(screen.getByTestId('email-code-input'), '123456');
    await user.click(screen.getByTestId('email-verify'));
    expect(relay.verify).toHaveBeenCalledWith('a@example.com', '123456');
    expect(await screen.findByTestId('handoff-sent')).toHaveTextContent('Sent to Signer Two');
    expect(relay.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the code step on a wrong code, with no address or key in the details', async () => {
    const user = userEvent.setup();
    const relay = fakeRelay(false, {
      verify: vi.fn(() =>
        Promise.resolve({ ok: false as const, code: 'bad-code' as const, status: 401, error: 'The code is wrong or ran out. Check the latest email, or ask for a new code.' }),
      ),
    });
    mount();
    await finishTurn(user);
    await emailTo(user, 'b@example.com');
    await user.click(screen.getByTestId('email-continue'));
    await waitFor(() => expect(screen.getByTestId('email-send-code')).toBeEnabled());
    await user.type(screen.getByTestId('email-own'), 'a@example.com');
    await user.click(screen.getByTestId('email-send-code'));
    await user.type(await screen.findByTestId('email-code-input'), '000000');
    await user.click(screen.getByTestId('email-verify'));

    const error = await screen.findByTestId('email-error');
    expect(error).toHaveTextContent('The code is wrong or ran out');
    expect(screen.getByTestId('email-code-input')).toHaveAttribute('aria-invalid', 'true');
    expect(relay.uploadHandoff).not.toHaveBeenCalled();
    expect(relay.send).not.toHaveBeenCalled();
    // The technical details name the code only.
    await user.click(screen.getByText('Technical details'));
    const details = (screen.getByTestId('error-details-text') as HTMLTextAreaElement).value;
    expect(details).toContain('code: relay-bad-code');
    expect(details).not.toMatch(/example\.com|AAECAwQF/);
    expect(localStorage.length).toBe(0);
  });

  it('refuses to email a document too large for the relay, and offers the PDF', async () => {
    const user = userEvent.setup();
    const relay = fakeRelay(true);
    prepare.result = () => ({ ok: false, tooLarge: true, bytes: 50 * 2 ** 20 });
    mount();
    await finishTurn(user);
    await emailTo(user, 'b@example.com');
    await user.click(screen.getByTestId('email-continue'));

    expect(await screen.findByTestId('email-error')).toHaveTextContent(
      'Too large to email. Download the PDF for Signer Two instead.',
    );
    expect(relay.uploadHandoff).not.toHaveBeenCalled();
    expect(screen.queryByTestId('email-continue')).toBeNull();
    await user.click(screen.getByTestId('email-download-instead'));
    const sent = await screen.findByTestId('handoff-sent');
    expect(sent).toHaveTextContent('Send this file to Signer Two');
    expect(click).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
  });

  it('offers a retry after a failed email that sends without uploading again', async () => {
    const user = userEvent.setup();
    const send = vi
      .fn<RelayClient['send']>()
      .mockResolvedValueOnce({ ok: false, code: 'email-failed', status: 502, error: 'The email could not be sent. Try again.' })
      .mockResolvedValueOnce({ ok: true, value: null });
    const relay = fakeRelay(true, { send });
    mount();
    await finishTurn(user);
    await emailTo(user, 'b@example.com');
    await user.click(screen.getByTestId('email-continue'));
    expect(await screen.findByTestId('email-error')).toHaveTextContent('The email could not be sent. Try again.');
    expect(localStorage.length).toBe(0);
    await user.click(screen.getByTestId('email-retry'));
    expect(await screen.findByTestId('handoff-sent')).toHaveTextContent('Sent to Signer Two');
    expect(relay.uploadHandoff).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('encrypts again when the password changes before a retry', async () => {
    const user = userEvent.setup();
    const send = vi
      .fn<RelayClient['send']>()
      .mockResolvedValueOnce({ ok: false, code: 'email-failed', status: 502, error: 'The email could not be sent. Try again.' })
      .mockResolvedValueOnce({ ok: true, value: null });
    const relay = fakeRelay(true, { send });
    mount();
    await finishTurn(user);
    await emailTo(user, 'b@example.com');
    await user.type(screen.getByTestId('email-password'), 'first-passphrase');
    await user.click(screen.getByTestId('email-continue'));
    await screen.findByTestId('email-error');
    await user.click(screen.getByTestId('email-handoff-dialog-close'));
    // The address stays in the block of choices.
    expect(screen.getByTestId('next-email')).toHaveValue('b@example.com');
    await user.click(screen.getByTestId('email-handoff'));
    await user.type(screen.getByTestId('email-password'), 'second-passphrase');
    await user.click(screen.getByTestId('email-continue'));
    await screen.findByTestId('handoff-sent');
    expect(prepare.calls.map((call) => call.password)).toEqual(['first-passphrase', 'second-passphrase']);
    expect(relay.uploadHandoff).toHaveBeenCalledTimes(2);
  });

  it('refuses a passphrase under 8 characters before any request', async () => {
    const user = userEvent.setup();
    const relay = fakeRelay(true);
    mount();
    await finishTurn(user);
    await emailTo(user, 'b@example.com');
    expect(screen.getByTestId('email-recipient')).toHaveTextContent('collect the signed PDF on another device');
    await user.type(screen.getByTestId('email-password'), 'seven77');
    await user.click(screen.getByTestId('email-continue'));
    expect(screen.getByTestId('email-error')).toHaveTextContent('The passphrase needs at least 8 characters.');
    expect(screen.getByTestId('email-password')).toHaveAttribute('aria-invalid', 'true');
    expect(prepare.calls).toEqual([]);
    expect(relay.uploadHandoff).not.toHaveBeenCalled();
    await user.type(screen.getByTestId('email-password'), '8');
    await user.click(screen.getByTestId('email-continue'));
    await screen.findByTestId('handoff-sent');
    expect(relay.send).toHaveBeenCalledWith(SESSION, ID, KEY, WRAPPED);
  });

  it('warns when this device cannot keep the key', async () => {
    const user = userEvent.setup();
    fakeRelay(true);
    mount();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { ...localStorage, setItem: () => { throw new Error('QuotaExceededError'); } },
    });
    await finishTurn(user);
    await emailTo(user, 'b@example.com');
    await user.click(screen.getByTestId('email-continue'));
    await screen.findByTestId('handoff-sent');
    expect(screen.getByTestId('handoff-not-stored')).toHaveTextContent('could not keep the key');
  });

  it('checks the address before any request', async () => {
    const user = userEvent.setup();
    const relay = fakeRelay(true);
    mount();
    await finishTurn(user);
    await user.type(await screen.findByTestId('next-email'), 'not an address');
    expect(screen.getByTestId('email-handoff')).toBeDisabled();
    // Enter in the field does not open the panel either.
    await user.type(screen.getByTestId('next-email'), '{Enter}');
    expect(screen.queryByTestId('email-handoff-dialog')).toBeNull();
    expect(relay.uploadHandoff).not.toHaveBeenCalled();
  });

  it('is not offered when this server has no relay', async () => {
    const user = userEvent.setup();
    const relay = fakeRelay(true, {
      config: vi.fn(() =>
        Promise.resolve({ ok: false as const, code: 'not-available' as const, status: 200, error: 'Email is not available on this server. Download the PDF instead.' }),
      ),
    });
    mount();
    await finishTurn(user);
    await waitFor(() => expect(relay.config).toHaveBeenCalled());
    // Without the relay, the download is the first choice and the primary one.
    expect(screen.getByTestId('sign-button')).toHaveTextContent('Download PDF for Signer Two');
    expect(screen.getByTestId('sign-button')).toHaveClass('primary');
    expect(screen.queryByTestId('next-email')).toBeNull();
    expect(screen.queryByTestId('email-handoff')).toBeNull();
  });

  it('is not offered with more than two signers', async () => {
    const user = userEvent.setup();
    fakeRelay(true);
    const three = makeResolved(TWO_SIGNER_FIELDS, {
      signers: [
        { id: 'a', name: 'Signer One' },
        { id: 'b', name: 'Signer Two' },
        { id: 'c', name: 'Signer Three' },
      ],
    });
    mount(three);
    await finishTurn(user);
    // Without email, the download is the first choice and the primary one.
    expect(screen.getByTestId('sign-button')).toHaveTextContent('Download PDF for Signer Two');
    expect(screen.getByTestId('sign-button')).toHaveClass('primary');
    expect(screen.queryByTestId('next-email')).toBeNull();
    expect(screen.queryByTestId('email-handoff')).toBeNull();
  });
});
