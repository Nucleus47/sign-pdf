/**
 * The next signer opens an emailed document and signs it (issue #70): the open
 * card, the route into the sign view, and the end of the turn that sends the
 * signed PDF back. The core and the relay client are fakes; the relay crypto
 * is replaced (jsdom has no crypto.subtle; lib/relayOpen.test.ts covers it).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo } from '@sign-pdf/spec';
import { App } from '../App.tsx';
import { setCore, type CoreApi, type FinalizeResult, type HandoffContents, type HumanInput } from '../lib/core.ts';
import { setRelayClient, type RelayClient, type RelayResult } from '../lib/relayClient.ts';
import { CONSENT_TEXT } from '../lib/signing.ts';
import { fakeCore, makeAudit, makeTwoSignerResolved, PNG_BYTES, SHA, TWO_SIGNERS } from '../testing/fixtures.ts';

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

const crypto = vi.hoisted(() => ({
  /** The password that opens the blob; undefined for none. */
  password: undefined as string | undefined,
  derive: [] as (string | undefined)[],
  tampered: false,
}));

vi.mock('../lib/relayCrypto.ts', async (importActual) => {
  const actual = await importActual<typeof import('../lib/relayCrypto.ts')>();
  return {
    ...actual,
    deriveDocKey: (_key: Uint8Array, _id: string, password?: string) => {
      crypto.derive.push(password);
      return Promise.resolve({ password } as unknown as CryptoKey);
    },
    decryptBlob: (docKey: { password?: string }, _id: string, purpose: string, blob: Uint8Array) => {
      if (crypto.tampered) throw new actual.RelayCryptoError('relay-blob-format', 'x');
      if (purpose !== 'handoff' || docKey.password !== crypto.password) {
        return Promise.reject(new actual.RelayCryptoError('relay-decrypt-failed', 'x'));
      }
      return Promise.resolve(blob);
    },
    encryptBlob: (_docKey: unknown, _id: string, purpose: string) =>
      Promise.resolve(new Uint8Array(purpose === 'final' ? [9, 9] : [0])),
  };
});

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const BLOB = new Uint8Array([0x53, 0x50, 0x52, 0x31]);

const passA: HumanInput = {
  signerId: 'a',
  signerName: 'Signer One',
  consent: { text: CONSENT_TEXT, acceptedAt: '2026-01-02T03:04:05.000Z' },
  signedAt: '2026-01-02T03:04:05.000Z',
  values: { dateA: '2026-01-02' },
  signatures: { sigA: { png: PNG_BYTES, method: 'typed' } },
};

const contents = (signers = TWO_SIGNERS, passes = [passA]): HandoffContents =>
  ({
    packet: { request: { version: 1, document: { name: 'agreement.pdf', sha256: SHA }, fields: [], signers }, passes: [] },
    pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    passes,
  }) as unknown as HandoffContents;

let restore: (() => void)[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let click: ReturnType<typeof vi.spyOn>;

function relay(overrides: Partial<RelayClient> = {}) {
  const notUsed = () => Promise.reject(new Error('not expected'));
  const client: RelayClient = {
    config: notUsed,
    login: notUsed,
    verify: notUsed,
    uploadHandoff: notUsed,
    send: notUsed,
    fetchHandoff: vi.fn(() => Promise.resolve({ ok: true as const, value: { blob: BLOB, password: crypto.password !== undefined } })),
    uploadFinal: vi.fn(() => Promise.resolve({ ok: true as const, value: null })),
    fetchFinal: notUsed,
    deleteDoc: notUsed,
    currentSession: () => null,
    clearSession: () => undefined,
    ...overrides,
  };
  restore.push(setRelayClient(client));
  return client;
}

function mount(password: boolean, decoded: HandoffContents = contents()) {
  const result: FinalizeResult = { pdf: new Uint8Array([1, 2]), audit: makeAudit(), sha256: 'd'.repeat(64) };
  const core = {
    decodeHandoff: vi.fn<CoreApi['decodeHandoff']>(() => Promise.resolve(decoded)),
    finalizeDocument: vi.fn<CoreApi['finalizeDocument']>(() => Promise.resolve(result)),
  };
  restore.push(
    setCore(fakeCore({ ...core, resolveRequest: () => Promise.resolve(makeTwoSignerResolved()) })),
  );
  render(<App sessionNonce={null} relayLink={{ id: ID, key: KEY, password }} />);
  return core;
}

/** Signer Two fills their turn and signs. */
async function signAsB(user: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByTestId('guide-position')).toHaveTextContent('Signer Two');
  await user.click(screen.getByTestId('guide-next'));
  await user.click(screen.getByText('stub: use signature'));
  await user.click(screen.getByTestId('guide-next'));
  await user.click(screen.getByTestId('consent'));
  await user.click(screen.getByTestId('sign-button'));
}

beforeEach(() => {
  crypto.password = undefined;
  crypto.derive = [];
  crypto.tampered = false;
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  fetchMock = vi.fn(() => Promise.reject(new Error('no network in this test')));
  vi.stubGlobal('fetch', fetchMock);
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
  click.mockRestore();
  vi.unstubAllGlobals();
});

describe('open an emailed document', () => {
  it('shows the open card and fetches nothing before Open', async () => {
    const client = relay();
    mount(false);
    const card = screen.getByTestId('relay-open');
    expect(card).toHaveTextContent('Open the document');
    expect(card).toHaveTextContent('Someone asked you to sign a document. It is decrypted on this device.');
    expect(screen.queryByTestId('relay-password')).toBeNull();
    expect(screen.getByTestId('app-root')).toHaveAttribute('data-view', 'relay-open');
    expect(client.fetchHandoff).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires the password when the link says p=1, before fetching', async () => {
    const user = userEvent.setup();
    crypto.password = 'pässword';
    const client = relay();
    mount(true);
    await user.click(screen.getByTestId('relay-open-button'));
    expect(screen.getByTestId('relay-open-error')).toHaveTextContent('Enter the password.');
    expect(screen.getByTestId('relay-password')).toHaveAttribute('aria-invalid', 'true');
    expect(client.fetchHandoff).not.toHaveBeenCalled();
    expect(crypto.derive).toEqual([]);
  });

  it('says to check the password when it is wrong, and does not fetch again on the retry', async () => {
    const user = userEvent.setup();
    crypto.password = 'right';
    const client = relay();
    const core = mount(true);
    await user.type(screen.getByTestId('relay-password'), 'wrong');
    await user.click(screen.getByTestId('relay-open-button'));
    const error = await screen.findByTestId('relay-open-error');
    expect(error).toHaveTextContent('Could not open. Check the password.');
    expect(error).toHaveAttribute('data-code', 'relay-decrypt-failed');
    // The error report holds the code only: no key, id or password.
    expect(document.body.textContent).not.toContain(KEY);
    expect(document.body.textContent).not.toContain(ID);
    expect(document.body.textContent).not.toContain('wrong');
    expect(screen.getByTestId('app-root')).toHaveAttribute('data-view', 'relay-open');

    await user.clear(screen.getByTestId('relay-password'));
    await user.type(screen.getByTestId('relay-password'), 'right');
    await user.click(screen.getByTestId('relay-open-button'));
    await waitFor(() => expect(screen.getByTestId('app-root')).toHaveAttribute('data-view', 'sign'));
    expect(client.fetchHandoff).toHaveBeenCalledTimes(1);
    expect(client.fetchHandoff).toHaveBeenCalledWith(ID);
    expect(crypto.derive).toEqual(['wrong', 'right']);
    expect(core.decodeHandoff).toHaveBeenCalledWith(BLOB);
  });

  it('asks for the password after the fetch when the relay says there is one and the link did not', async () => {
    const user = userEvent.setup();
    crypto.password = 'right';
    const client = relay();
    mount(false);
    await user.click(screen.getByTestId('relay-open-button'));
    expect(await screen.findByTestId('relay-open-error')).toHaveTextContent('This document has a password. Enter it.');
    expect(crypto.derive).toEqual([]);
    await user.type(screen.getByTestId('relay-password'), 'right');
    await user.click(screen.getByTestId('relay-open-button'));
    await waitFor(() => expect(screen.getByTestId('app-root')).toHaveAttribute('data-view', 'sign'));
    expect(client.fetchHandoff).toHaveBeenCalledTimes(1);
    expect(crypto.derive).toEqual(['right']);
  });

  it('opens without a password when the link says p=1 but the relay says there is none', async () => {
    const user = userEvent.setup();
    relay();
    mount(true);
    await user.type(screen.getByTestId('relay-password'), 'anything');
    await user.click(screen.getByTestId('relay-open-button'));
    await waitFor(() => expect(screen.getByTestId('app-root')).toHaveAttribute('data-view', 'sign'));
    expect(crypto.derive).toEqual([undefined]);
  });

  it('says the format is wrong for a blob that is not one', async () => {
    const user = userEvent.setup();
    crypto.tampered = true;
    relay();
    mount(false);
    await user.click(screen.getByTestId('relay-open-button'));
    expect(await screen.findByTestId('relay-open-error')).toHaveAttribute('data-code', 'relay-blob-format');
  });

  it('says the link expired when the relay has no document', async () => {
    const user = userEvent.setup();
    const notFound: RelayResult<never> = { ok: false, code: 'not-found', status: 404, error: 'x' };
    relay({ fetchHandoff: vi.fn(() => Promise.resolve(notFound)) });
    mount(false);
    await user.click(screen.getByTestId('relay-open-button'));
    const error = await screen.findByTestId('relay-open-error');
    expect(error).toHaveTextContent('This link has expired or was already used.');
    expect(error).toHaveAttribute('data-code', 'not-found');
  });

  it('refuses a packet that is not two signers with one finished turn', async () => {
    const user = userEvent.setup();
    relay();
    mount(false, contents([...TWO_SIGNERS, { id: 'c', name: 'Signer Three' }]));
    await user.click(screen.getByTestId('relay-open-button'));
    expect(await screen.findByTestId('relay-open-error')).toHaveAttribute('data-code', 'invalid-handoff');
    expect(screen.getByTestId('app-root')).toHaveAttribute('data-view', 'relay-open');
  });
});

describe('the end of the next signer’s turn', () => {
  it('encrypts the signed PDF, uploads it to /final, says who it went back to, and posts nothing to /api', async () => {
    const user = userEvent.setup();
    const client = relay();
    const core = mount(false);
    await user.click(screen.getByTestId('relay-open-button'));
    await signAsB(user);
    await waitFor(() => expect(core.finalizeDocument).toHaveBeenCalledTimes(1));
    const inputs = core.finalizeDocument.mock.calls[0]?.[2] as HumanInput[];
    expect(inputs.map((input) => input.signerId)).toEqual(['a', 'b']);

    expect(await screen.findByTestId('sent-status')).toHaveTextContent('Sent back to Signer One.');
    expect(client.uploadFinal).toHaveBeenCalledWith(ID, new Uint8Array([9, 9]));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('download-signed'));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('still offers the download when the upload fails, and tries again', async () => {
    const user = userEvent.setup();
    const tooLarge: RelayResult<never> = { ok: false, code: 'too-large', status: 413, error: 'x' };
    const uploadFinal = vi
      .fn<RelayClient['uploadFinal']>()
      .mockResolvedValueOnce(tooLarge)
      .mockResolvedValueOnce({ ok: true, value: null });
    relay({ uploadFinal });
    mount(false);
    await user.click(screen.getByTestId('relay-open-button'));
    await signAsB(user);
    const error = await screen.findByTestId('sent-error');
    expect(error).toHaveTextContent('Download it and send it to Signer One yourself.');
    expect(screen.getByTestId('download-signed')).toBeEnabled();
    await user.click(screen.getByTestId('send-again'));
    expect(await screen.findByTestId('sent-status')).toHaveTextContent('Sent back to Signer One.');
    expect(uploadFinal).toHaveBeenCalledTimes(2);
  });

  it('counts a final that is already there as sent', async () => {
    const user = userEvent.setup();
    const exists: RelayResult<never> = { ok: false, code: 'already-sent', status: 409, error: 'x' };
    relay({ uploadFinal: vi.fn(() => Promise.resolve(exists)) });
    mount(false);
    await user.click(screen.getByTestId('relay-open-button'));
    await signAsB(user);
    expect(await screen.findByTestId('sent-status')).toHaveTextContent('Sent back to Signer One.');
  });
});
