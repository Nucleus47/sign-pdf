import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { hasWorkToLose } from './app/open.ts';
import { setCore, type CoreApi } from './lib/core.ts';
import { setRelayClient, type RelayClient } from './lib/relayClient.ts';
import { PACKET_TIMEOUT_MS } from './lib/transport.ts';
import { fakeCore, SHA } from './testing/fixtures.ts';

const TOKEN = 'unit-session-token';
const NONCE = 'unit-session-nonce';
const jsonAnswer = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });
const tokenAnswer = () => jsonAnswer(JSON.stringify({ token: TOKEN }));
const packetText = JSON.stringify({ kind: 'sign-pdf-packet', version: 1, request: {}, pdfBase64: 'AA==' });
const request = {
  version: 1 as const,
  document: { name: 'agreement.pdf', sha256: SHA },
  fields: [{ id: 'sig', type: 'signature' as const, assignee: 'human' as const, required: true, placement: { kind: 'anchor' as const, text: 'Sign:', occurrence: 1, align: 'right' as const, dx: 0, dy: 0, width: 100, height: 30 } }],
};

let restore: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  restore?.();
  restore = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const state = () => screen.getByTestId('app-root').getAttribute('data-state');

describe('opening a session', () => {
  it('stops waiting after the time limit, says so, and can ask again', async () => {
    const decodePacket: CoreApi['decodePacket'] = () =>
      Promise.resolve({ packet: { kind: 'sign-pdf-packet', version: 1, request, pdfBase64: 'AA==' }, pdf: new Uint8Array([1]) });
    // The document never finishes resolving: the test is about getting this far.
    restore = setCore(fakeCore({ decodePacket, resolveRequest: () => new Promise(() => undefined) }));
    const answers: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(
      (_url: string, _init?: RequestInit) => new Promise<Response>((resolve) => answers.push(resolve)),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<App sessionNonce={NONCE} />);
    expect(screen.getByText('Getting the document from the requesting app…')).toBeInTheDocument();
    expect(state()).toBe('opening');
    // First the nonce is exchanged for the token; the packet request follows.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/session');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ nonce: NONCE });
    await act(async () => {
      answers[0]?.(tokenAnswer());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/packet');

    await act(() => vi.advanceTimersByTimeAsync(PACKET_TIMEOUT_MS - 1));
    expect(screen.queryByTestId('connect-problem')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByTestId('connect-problem')).toHaveTextContent('did not answer within 15 seconds');
    expect(state()).toBe('empty');
    expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);

    // Asking again reuses the token: the nonce works only once.
    fireEvent.click(screen.getByTestId('connect-retry'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/packet');
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(screen.queryByTestId('connect-problem')).toBeNull();
    await act(async () => {
      answers[2]?.(new Response(packetText, { status: 200, headers: { 'content-type': 'application/json' } }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Reading the document…')).toBeInTheDocument();
    expect(state()).toBe('opening');
  });
});

describe('a signing link that cannot be used', () => {
  it('says after a reload that the link works once and how to get a new one, without asking the app', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<App sessionNonce={null} sessionLinkReloaded />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('This signing link is no longer valid');
    const problem = screen.getByTestId('link-problem');
    expect(problem).toHaveTextContent('This page was reloaded, and a signing link works only once.');
    expect(problem).toHaveTextContent('run the command again to get a new link');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const answerWith = (code: string, status: number) => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonAnswer(JSON.stringify({ error: 'A sentence.', code }), status)),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('says the link was already opened, and offers no way to continue', async () => {
    const fetchMock = answerWith('session-already-opened', 401);
    render(<App sessionNonce={NONCE} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const problem = screen.getByTestId('link-problem');
    expect(problem).toHaveAttribute('data-problem', 'already-opened');
    expect(problem).toHaveTextContent(
      'This signing link was already opened, in another tab or by another program. Ask the app that sent it to start again; do not sign if you did not open it yourself.',
    );
    expect(problem).toHaveTextContent('If you reloaded this page or the command has ended, run the command again to get a new link.');
    expect(problem.querySelector('button')).toBeNull();
    expect(screen.queryByTestId('connect-retry')).toBeNull();
    expect(state()).toBe('empty');
    // Only the exchange was tried: no packet request without a token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid-nonce', 401],
    ['session-locked', 429],
    ['session-finished', 409],
  ])('says the link is no longer valid on %s', async (code, status) => {
    const fetchMock = answerWith(code, status);
    render(<App sessionNonce={NONCE} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('This signing link is no longer valid');
    expect(screen.getByTestId('link-problem')).toHaveAttribute('data-problem', 'not-valid');
    expect(screen.getByTestId('link-problem')).toHaveTextContent('start a new signature request');
    expect(screen.getByTestId('link-problem')).toHaveTextContent('run the command again to get a new link');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('link-problem-home'));
    expect(screen.getByTestId('app-root')).toHaveAttribute('data-view', 'home');
  });

  it('offers to try again when the requesting app cannot be reached, and sends the nonce again', async () => {
    const fetchMock = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(tokenAnswer())
      .mockResolvedValueOnce(jsonAnswer('{"error":"Done.","code":"session-finished"}', 409));
    vi.stubGlobal('fetch', fetchMock);
    render(<App sessionNonce={NONCE} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('connect-problem')).toHaveTextContent('The requesting app did not answer.');
    expect(screen.getByTestId('connect-problem')).toHaveTextContent('If you reloaded this page or the command has ended, run the command again');
    fireEvent.click(screen.getByTestId('connect-retry'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/session', '/api/session', '/api/packet']);
    expect(screen.getByTestId('link-problem')).toHaveAttribute('data-problem', 'not-valid');
  });

  it('never puts the token or the nonce in browser storage or on the page', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(url === '/api/session' ? tokenAnswer() : jsonAnswer('{}', 500))),
    );
    render(<App sessionNonce={NONCE} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('link-problem')).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(NONCE);
    setItem.mockRestore();
  });
});

describe('a document that cannot be signed', () => {
  it('reports its own state and does not ask before leaving', async () => {
    const decodePacket: CoreApi['decodePacket'] = () =>
      Promise.resolve({ packet: { kind: 'sign-pdf-packet', version: 1, request, pdfBase64: 'AA==' }, pdf: new Uint8Array([1]) });
    const failure = Object.assign(new Error('anchor "Sign:" not found'), { code: 'anchor-not-found', fieldId: 'sig' });
    restore = setCore(fakeCore({ decodePacket, resolveRequest: () => Promise.reject(failure) }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(url === '/api/session' ? tokenAnswer() : jsonAnswer(packetText))),
    );

    render(<App sessionNonce={NONCE} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('resolve-error')).toBeInTheDocument();
    expect(state()).toBe('cannot-sign');
    expect(screen.getByTestId('doc-state')).toHaveTextContent('This document cannot be signed yet');

    fireEvent.click(screen.getByTestId('nav-home'));
    expect(screen.queryByTestId('leave-dialog')).toBeNull();
    expect(state()).toBe('empty');
  });

  it('describes email hand-off only when this server has the relay on', async () => {
    restore = setCore(fakeCore({}));
    const relay = { config: vi.fn(() => Promise.resolve({ ok: false as const, code: 'not-available' as const, status: 404 })) };
    const restoreRelay = setRelayClient(relay as unknown as RelayClient);
    try {
      const { unmount } = render(<App sessionNonce={null} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(relay.config).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('home-how-email')).toBeNull();
      expect(screen.getByText('Everything happens in your browser. Nothing is uploaded.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('On your own devices');
      unmount();

      relay.config.mockImplementation(() => Promise.resolve({ ok: true, value: { turnstileSiteKey: '' } } as never));
      render(<App sessionNonce={null} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByTestId('home-how-email')).toHaveTextContent('By email through this site (optional)');
      expect(screen.getByText(/unless you choose to email it/)).toBeInTheDocument();
    } finally {
      restoreRelay();
    }
  });
});

describe('hasWorkToLose', () => {
  it('is true only where the person has entered something', () => {
    expect(hasWorkToLose('sign', 0, 'awaiting-human')).toBe(true);
    expect(hasWorkToLose('sign', 0, 'cannot-sign')).toBe(false);
    expect(hasWorkToLose('sign', 0, 'opening')).toBe(false);
    expect(hasWorkToLose('sign', 0, 'signed')).toBe(false);
    expect(hasWorkToLose('prepare', 2, 'opening')).toBe(true);
    expect(hasWorkToLose('prepare', 0, 'opening')).toBe(false);
    expect(hasWorkToLose('home', 3, 'awaiting-human')).toBe(false);
  });
});

describe('the home page', () => {
  it('offers the two routes, received file first, and keeps an unreadable file on the home page', async () => {
    restore = setCore(fakeCore({}));
    render(<App sessionNonce={null} />);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Did you receive a file to sign? Start here.',
      'Want to prepare a file for signature? Start here.',
      'How it works',
    ]);
    // One input for what was received: a hand-off PDF or a packet.
    const received = screen.getByTestId('open-packet-input');
    expect(received.getAttribute('accept')).toBe('.pdf,.json,application/pdf,application/json');
    expect(screen.getByTestId('home-agent-hint')).toHaveTextContent('AI agent? Read /skill.md first.');
    expect(screen.getByTestId('skill-link')).toHaveAttribute('href', '/skill.md');
    expect(screen.getByTestId('home-agent')).toHaveTextContent('opens the document in your browser; you sign.');
    expect(screen.getByTestId('agent-link')).toHaveTextContent('llms.txt');
    expect(screen.getByTestId('home-open-source')).toHaveTextContent('Open source under the MIT license.');
    expect(screen.getByTestId('repo-link')).toHaveAttribute('href', 'https://github.com/Nucleus47/sign-pdf');
    expect(screen.getByTestId('npm-mcp-link')).toHaveAttribute('href', 'https://www.npmjs.com/package/@sign-pdf/mcp');
    expect(screen.getByTestId('npm-cli-link')).toHaveAttribute('href', 'https://www.npmjs.com/package/@sign-pdf/cli');

    fireEvent.change(received, { target: { files: [new File(['plain words'], 'holiday.txt', { type: 'text/plain' })] } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('home-error-text')).toHaveTextContent('“holiday.txt” is not a PDF');
    expect(state()).toBe('empty');
  });
});
