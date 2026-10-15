/**
 * "Documents you sent" (issue #98): email a kept hand-off again through the
 * real relay client with an injected fetch, download it, remove it. The kept
 * entries are in fake-indexeddb. Encryption is replaced (jsdom has no
 * crypto.subtle); lib/relaySend.test.ts covers it.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCore, type CoreApi } from '../lib/core.ts';
import { createRelayClient, setRelayClient } from '../lib/relayClient.ts';
import { loadRelayEntry } from '../lib/relayStore.ts';
import { keepSentHandoff, listSentHandoffs, type SentHandoff } from '../lib/sentStore.ts';
import { fakeCore } from '../testing/fixtures.ts';
import { SentList } from './SentList.tsx';

const OLD_ID = 'AAECAwQFBgcICQoLDA0ODw';
const NEW_ID = 'EBESExQVFhcYGRobHB0eHw';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const EXPIRES = '2099-10-20T12:00:00.000Z';
const SESSION = { session: 'payload.signature', expiresAt: '2099-01-01T00:00:00.000Z' };

const ENTRY: SentHandoff = {
  id: OLD_ID,
  blob: new Uint8Array([7, 7, 7]),
  document: 'agreement.pdf',
  next: 'Bea Example',
  fileName: 'agreement-signed-1-of-2-handoff.pdf',
  signedName: 'agreement-signed.pdf',
  to: 'b@example.com',
  createdAt: '2099-10-01T11:00:00.000Z',
  sentAt: '2099-10-01T11:01:00.000Z',
  exp: '2099-10-08T11:01:00.000Z',
  prev: [],
};

vi.mock('../lib/relaySend.ts', async (importActual) => {
  const actual = await importActual<typeof import('../lib/relaySend.ts')>();
  return {
    ...actual,
    prepareHandoff: (_packetText: string, to: string, password?: string) =>
      Promise.resolve({
        ok: true,
        prepared: { id: NEW_ID, key: KEY, blob: new Uint8Array([1, 2, 3]), to, password: password !== undefined },
      }),
  };
});

const keyState = vi.hoisted(() => ({ missing: false }));
vi.mock('../lib/sendAgain.ts', async (importActual) => ({
  ...(await importActual<typeof import('../lib/sendAgain.ts')>()),
  keptNeedsPassword: () => false,
  openKeptHandoff: () =>
    Promise.resolve(
      keyState.missing
        ? { ok: false, code: 'relay-key-missing', message: 'This browser no longer has the key to open this copy.' }
        : { ok: true, packet: new TextEncoder().encode('{"kind":"sign-pdf-packet","note":"synthetic"}') },
    ),
}));

const downloads = vi.hoisted(() => [] as { name: string; bytes: Uint8Array }[]);
vi.mock('../lib/files.ts', async (importActual) => ({
  ...(await importActual<typeof import('../lib/files.ts')>()),
  downloadFile: (name: string, bytes: Uint8Array) => void downloads.push({ name, bytes }),
}));

interface Call {
  method: string;
  path: string;
}

/** The relay as fetch sees it: upload answers with the expiry, send with `sendStatus`. */
function relayFetch(sendStatus: number, calls: Call[]) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ method: init?.method ?? 'GET', path });
    const json = (status: number, value: unknown) =>
      Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }));
    if (init?.method === 'PUT') return json(200, { id: NEW_ID, expiresAt: EXPIRES });
    if (path.endsWith('/send')) {
      return sendStatus === 200 ? json(200, { ok: true }) : json(sendStatus, { error: 'mail failed', code: 'email-failed' });
    }
    return json(404, { error: 'no', code: 'not-found' });
  };
}

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
    clear: () => items.clear(),
  };
}

let restoreRelay: () => void = () => undefined;
let restoreCore: () => void = () => undefined;

function useRelay(sendStatus: number): Call[] {
  const calls: Call[] = [];
  const client = createRelayClient({ fetch: relayFetch(sendStatus, calls) });
  // A live sign-in in this tab: the dialog goes straight to "Send email".
  restoreRelay = setRelayClient({ ...client, currentSession: () => SESSION });
  return calls;
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  downloads.length = 0;
  keyState.missing = false;
  await keepSentHandoff(ENTRY);
});

afterEach(() => {
  restoreRelay();
  restoreCore();
});

describe('Documents you sent', () => {
  it('emails a kept document again under a new id, and keeps the old entry until the send succeeded', async () => {
    const calls = useRelay(200);
    const user = userEvent.setup();
    render(<SentList onStartOver={() => undefined} />);
    const item = await screen.findByTestId('sent-item');
    expect(within(item).getByText('agreement.pdf')).toBeInTheDocument();
    expect(within(item).getByTestId('sent-item-download')).toHaveTextContent('Download the PDF for Bea Example');

    await user.click(within(item).getByTestId('sent-item-email'));
    expect(screen.getByTestId('email-to')).toHaveValue('b@example.com');
    // Before the send: only the old entry.
    expect((await listSentHandoffs()).map((entry) => entry.id)).toEqual([OLD_ID]);
    await user.click(screen.getByTestId('email-continue'));

    expect(await screen.findByTestId('sent-list-status')).toHaveTextContent('Sent to Bea Example (b@example.com)');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `PUT /relay/docs/${NEW_ID}`,
      `POST /relay/docs/${NEW_ID}/send`,
    ]);
    const kept = await listSentHandoffs();
    expect(kept).toHaveLength(1);
    // The new entry holds the ciphertext that was uploaded for the new id.
    expect(kept[0]).toMatchObject({ id: NEW_ID, prev: [OLD_ID], exp: EXPIRES });
    expect(Array.from(kept[0]!.blob)).toEqual([1, 2, 3]);
    // The key for the new link is kept, to open the signed PDF that comes back.
    expect(loadRelayEntry(window.localStorage, NEW_ID)).toMatchObject({ k: KEY, n: 'agreement-signed.pdf' });
  });

  it('leaves the old entry when the new send fails', async () => {
    const calls = useRelay(502);
    const user = userEvent.setup();
    render(<SentList onStartOver={() => undefined} />);
    await user.click(within(await screen.findByTestId('sent-item')).getByTestId('sent-item-email'));
    await user.click(screen.getByTestId('email-continue'));

    expect(await screen.findByTestId('email-error')).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith('/send'))).toBe(true);
    expect((await listSentHandoffs()).map((entry) => entry.id)).toEqual([OLD_ID]);
    expect(loadRelayEntry(window.localStorage, NEW_ID)).toBeNull();
  });

  it('says so when the key for a kept copy is gone, and opens no email panel', async () => {
    useRelay(200);
    keyState.missing = true;
    const user = userEvent.setup();
    render(<SentList onStartOver={() => undefined} />);
    await user.click(within(await screen.findByTestId('sent-item')).getByTestId('sent-item-email'));
    expect(await screen.findByTestId('sent-item-error')).toHaveTextContent('no longer has the key');
    expect(screen.queryByTestId('email-to')).toBeNull();
  });

  it('downloads the hand-off PDF built again from the kept packet, and removes an entry', async () => {
    useRelay(200);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const handoffPdf = new Uint8Array([9, 9, 9]);
    const buildHandoffPdf = vi.fn<CoreApi['buildHandoffPdf']>(() =>
      Promise.resolve({ pdf: handoffPdf, packet: {} } as unknown as Awaited<ReturnType<CoreApi['buildHandoffPdf']>>),
    );
    restoreCore = setCore(
      fakeCore({
        decodeHandoff: () =>
          Promise.resolve({ packet: { request: { version: 1 } }, pdf, passes: [] } as unknown as Awaited<
            ReturnType<CoreApi['decodeHandoff']>
          >),
        resolveRequest: () => Promise.resolve({} as Awaited<ReturnType<CoreApi['resolveRequest']>>),
        buildHandoffPdf,
      }),
    );
    const user = userEvent.setup();
    render(<SentList onStartOver={() => undefined} />);
    const item = await screen.findByTestId('sent-item');
    await user.click(within(item).getByTestId('sent-item-download'));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toEqual({ name: ENTRY.fileName, bytes: handoffPdf });
    expect(buildHandoffPdf).toHaveBeenCalledTimes(1);

    await user.click(within(item).getByTestId('sent-item-remove'));
    expect(await screen.findByTestId('sent-list-empty')).toBeInTheDocument();
    expect(await listSentHandoffs()).toEqual([]);
  });
});
