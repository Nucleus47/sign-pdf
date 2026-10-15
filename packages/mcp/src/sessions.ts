/**
 * Signature sessions started through the MCP server. Each one is a loopback
 * hand-off running in the background: `request_signature` returns at once and
 * `get_signature_status` reads the state kept here.
 *
 * The one-time signing link goes to the browser launcher and nowhere else:
 * nothing kept or returned here contains it, so no tool result can.
 */
import { randomUUID } from 'node:crypto';
import { CliError, startSignRequest, type SignOutcome, type SignRequestOptions } from '@sign-pdf/cli';
import type { Signer } from '@sign-pdf/spec';

export type SessionState = { status: 'pending' } | SignOutcome;

export interface SessionInfo {
  id: string;
  /** `http://127.0.0.1:<port>`. For display only: opening it does not open the document. */
  origin: string;
  /** Where the signed PDF is planned to go. The signed state reports where it went. */
  outPath: string;
  expiresAt: Date;
  /** The request's signers, who sign in turn. Empty for a request without `signers`. */
  signers: Signer[];
}

/** What a caller can choose. The store never overwrites a file and always opens the browser. */
export type SessionStartOptions = Omit<SignRequestOptions, 'force' | 'open' | 'ifExists'>;

interface Entry extends SessionInfo {
  state: SessionState;
  finished: Promise<void>;
  cancel(): Promise<void>;
}

/** More than a few sign views open at once is a mistake, not a workflow. */
const MAX_PENDING = 5;
/** Finished sessions are remembered so their result can still be read. */
const MAX_REMEMBERED = 50;

/**
 * The error for a hand-off whose browser could not be started. It carries no
 * link: the agent must not open the sign view, so the user starts the hand-off
 * themselves.
 */
export function browserUnavailableError(): CliError {
  return new CliError(
    'browser-unavailable',
    'The browser could not be opened on this computer, so the document was not shown to the user. The signature request was cancelled.',
    'Ask the user to run the sign-pdf CLI themselves in a terminal: sign-pdf request <pdf> <request.json>. Do not try to open the sign view yourself.',
  );
}

export class SessionStore {
  readonly #entries = new Map<string, Entry>();
  #closed = false;

  async start(options: SessionStartOptions): Promise<SessionInfo> {
    if (this.#closed) throw new CliError('cancelled', 'The server is shutting down.');
    const pending = [...this.#entries.values()].filter((entry) => entry.state.status === 'pending');
    if (pending.length >= MAX_PENDING) {
      throw new CliError(
        'session-limit',
        `${MAX_PENDING} signature requests are already waiting for the human.`,
        'Wait for one to finish (get_signature_status) before starting another.',
      );
    }
    const request = await startSignRequest({ ...options, force: false, open: true, ifExists: 'next-free' });
    if (!request.browserOpened) {
      // Nobody can reach the sign view, and the link must not go to the agent: end the session now.
      await request.cancel();
      await request.outcome;
      throw browserUnavailableError();
    }
    const entry: Entry = {
      id: randomUUID(),
      origin: request.origin,
      outPath: request.outPath,
      expiresAt: request.expiresAt,
      signers: request.signers,
      state: { status: 'pending' },
      cancel: request.cancel,
      finished: request.outcome.then((outcome) => {
        entry.state = outcome;
      }),
    };
    this.#entries.set(entry.id, entry);
    this.#forgetOldest();
    // The server may have been closed while this session was starting.
    if (this.#closed) await entry.cancel();
    return { id: entry.id, origin: entry.origin, outPath: entry.outPath, expiresAt: entry.expiresAt, signers: entry.signers };
  }

  /** The session's state, optionally waiting up to `waitMs` for it to finish. */
  async status(id: string, waitMs = 0): Promise<{ info: SessionInfo; state: SessionState }> {
    const entry = this.#entries.get(id);
    if (!entry) {
      throw new CliError(
        'session-not-found',
        `No signature session has the id ${JSON.stringify(id)}.`,
        'Use the session_id that request_signature returned. Sessions do not survive a restart of this server.',
      );
    }
    if (entry.state.status === 'pending' && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        entry.finished,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    const info: SessionInfo = {
      id: entry.id,
      origin: entry.origin,
      outPath: entry.outPath,
      expiresAt: entry.expiresAt,
      signers: entry.signers,
    };
    return { info, state: entry.state };
  }

  get pendingCount(): number {
    return [...this.#entries.values()].filter((entry) => entry.state.status === 'pending').length;
  }

  /** Close every session's server. Pending sessions end as cancelled. */
  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#entries.values()].map((entry) => entry.cancel().then(() => entry.finished)));
  }

  #forgetOldest(): void {
    for (const [id, entry] of this.#entries) {
      if (this.#entries.size <= MAX_REMEMBERED) break;
      if (entry.state.status !== 'pending') this.#entries.delete(id);
    }
  }
}
