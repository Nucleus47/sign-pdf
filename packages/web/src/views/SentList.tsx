/**
 * "Documents you sent" (issue #98): the hand-offs this device emailed and
 * still keeps (lib/sentStore.ts). Each can be emailed again under a new link,
 * downloaded as a hand-off PDF, or removed from this device.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { EmailHandoff, type EmailSent } from '../components/EmailHandoff.tsx';
import { ErrorDetails } from '../components/ErrorDetails.tsx';
import { toCoreProblem } from '../lib/core.ts';
import type { Failure } from '../lib/errorReport.ts';
import { RELAY_KEEP_AFTER_EXPIRY_DAYS } from '../lib/relayStore.ts';
import { displayText, formatDateTime, UNTRUSTED_TEXT_CLASS } from '../lib/displayText.ts';
import { downloadFile } from '../lib/files.ts';
import { handoffPdfFromPacket, keptNeedsPassword, openKeptHandoff } from '../lib/sendAgain.ts';
import {
  listSentHandoffs,
  removeSentHandoff,
  replaceSentHandoff,
  type SentHandoff,
} from '../lib/sentStore.ts';

export interface SentListProps {
  onStartOver: () => void;
}

/** What happened last, shown above the list. */
type Status =
  | { kind: 'sent'; next: string; to: string; expiresAt: string }
  | { kind: 'not-kept'; next: string }
  | { kind: 'problem'; id: string; text: string; failure: Failure };

function deviceStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function SentList({ onStartOver }: SentListProps) {
  const ids = useId();
  /** null while the list is read; `now` is when it was read; `locked` holds the ids that need a password. */
  const [list, setList] = useState<{ entries: SentHandoff[]; now: number; locked: Set<string> } | null>(null);
  /** The entry being emailed again, with its packet decrypted in memory. */
  const [emailing, setEmailing] = useState<{ entry: SentHandoff; packet: string } | null>(null);
  const [busy, setBusy] = useState<{ id: string; what: 'download' | 'email' } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  /** Passwords typed for kept copies, by id; memory only. */
  const [passwords, setPasswords] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const entries = await listSentHandoffs();
    const now = Date.now();
    const locked = new Set(entries.filter((entry) => keptNeedsPassword(entry, deviceStorage(), now)).map((entry) => entry.id));
    setList({ entries, now, locked });
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** Decrypt the kept copy in memory; on failure, say why next to it. */
  const open = async (entry: SentHandoff): Promise<Uint8Array | null> => {
    const opened = await openKeptHandoff(entry, deviceStorage(), passwords[entry.id] || undefined);
    if (opened.ok) return opened.packet;
    setStatus({ kind: 'problem', id: entry.id, text: opened.message, failure: { code: opened.code, message: opened.code } });
    return null;
  };

  const download = async (entry: SentHandoff, packet?: Uint8Array) => {
    setBusy({ id: entry.id, what: 'download' });
    setStatus(null);
    try {
      const bytes = packet ?? (await open(entry));
      if (!bytes) return;
      downloadFile(displayText(entry.fileName), await handoffPdfFromPacket(bytes), 'application/pdf');
    } catch (error) {
      const problem = toCoreProblem(error);
      setStatus({
        kind: 'problem',
        id: entry.id,
        text: 'The PDF could not be made from the copy in this browser. Remove it, and sign again from the start.',
        failure: { code: problem.code, message: problem.message },
      });
    } finally {
      setBusy(null);
    }
  };

  const emailAgain = async (entry: SentHandoff) => {
    setBusy({ id: entry.id, what: 'email' });
    setStatus(null);
    try {
      const bytes = await open(entry);
      if (bytes) setEmailing({ entry, packet: new TextDecoder().decode(bytes) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entry: SentHandoff) => {
    setStatus(null);
    await removeSentHandoff(entry.id);
    await reload();
  };

  /** The new send went out: keep it in place of the old entry. The old link still works until it expires. */
  const emailedAgain = async (old: SentHandoff, sent: EmailSent) => {
    setEmailing(null);
    const kept = await replaceSentHandoff(old, { id: sent.id, to: sent.to, exp: sent.expiresAt, blob: sent.blob });
    setStatus(kept ? { kind: 'sent', next: old.next, to: sent.to, expiresAt: sent.expiresAt } : { kind: 'not-kept', next: old.next });
    await reload();
  };

  return (
    <main className="centered" id="main">
      <section className="card narrow sent-list" data-testid="sent-list" aria-labelledby={`${ids}-title`}>
        <h1 id={`${ids}-title`}>Documents you sent</h1>
        <p className="lede">
          This browser keeps an encrypted copy of each document you emailed, so you can send it again. The copy is
          removed {RELAY_KEEP_AFTER_EXPIRY_DAYS} days after its link expires, or when you collect the signed PDF.
        </p>

        {status?.kind === 'sent' && (
          <p className="notice" role="status" data-testid="sent-list-status">
            Sent to <span className={UNTRUSTED_TEXT_CLASS}>{displayText(status.next)}</span> ({status.to}). The link works
            until {formatDateTime(status.expiresAt)}.
          </p>
        )}
        {status?.kind === 'not-kept' && (
          <p className="notice warning" role="status" data-testid="sent-list-status">
            Sent to <span className={UNTRUSTED_TEXT_CLASS}>{displayText(status.next)}</span>. This device could not keep the
            new copy.
          </p>
        )}

        {list === null ? (
          <p role="status">Reading the documents on this device…</p>
        ) : list.entries.length === 0 ? (
          <p data-testid="sent-list-empty">No sent documents are kept on this device.</p>
        ) : (
          <ul className="sent-items" aria-label="Documents you sent">
            {list.entries.map((entry) => {
              const next = displayText(entry.next);
              const expired = Date.parse(entry.exp) <= list.now;
              return (
                <li key={entry.id} className="sent-item" data-testid="sent-item">
                  <h2 className={UNTRUSTED_TEXT_CLASS}>{displayText(entry.document)}</h2>
                  <dl className="sent-slip">
                    <div>
                      <dt>Next signer</dt>
                      <dd className={UNTRUSTED_TEXT_CLASS}>{next}</dd>
                    </div>
                    {entry.to && (
                      <div>
                        <dt>To</dt>
                        <dd>{entry.to}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Sent</dt>
                      <dd data-testid="sent-item-sent">{entry.sentAt ? formatDateTime(entry.sentAt) : 'Not sent'}</dd>
                    </div>
                    {entry.sentAt && (
                      <div>
                        <dt>Link works until</dt>
                        <dd data-testid="sent-item-until">{expired ? 'Expired' : formatDateTime(entry.exp)}</dd>
                      </div>
                    )}
                  </dl>
                  {list.locked.has(entry.id) && (
                    <div className="form-item">
                      <label htmlFor={`${ids}-${entry.id}-password`}>Password</label>
                      <input
                        id={`${ids}-${entry.id}-password`}
                        className="input"
                        type="password"
                        autoComplete="off"
                        maxLength={200}
                        data-testid="sent-item-password"
                        value={passwords[entry.id] ?? ''}
                        onChange={(event) => setPasswords((previous) => ({ ...previous, [entry.id]: event.target.value }))}
                        aria-describedby={`${ids}-${entry.id}-password-hint`}
                      />
                      <p className="hint" id={`${ids}-${entry.id}-password-hint`}>
                        The password you set when you emailed the document. It opens the copy in this browser.
                      </p>
                    </div>
                  )}
                  {status?.kind === 'problem' && status.id === entry.id && (
                    <div className="form-error" role="alert" data-testid="sent-item-error">
                      <p>{status.text}</p>
                      <ErrorDetails failure={status.failure} />
                    </div>
                  )}
                  <div className="button-row">
                    <button
                      type="button"
                      className="button primary"
                      data-testid="sent-item-email"
                      disabled={busy?.id === entry.id}
                      onClick={() => void emailAgain(entry)}
                    >
                      Email it again
                    </button>
                    <button
                      type="button"
                      className="button"
                      data-testid="sent-item-download"
                      disabled={busy?.id === entry.id}
                      onClick={() => void download(entry)}
                    >
                      {busy?.id === entry.id && busy.what === 'download' ? 'Making the PDF…' : `Download the PDF for ${next}`}
                    </button>
                    <button type="button" className="button quiet" data-testid="sent-item-remove" onClick={() => void remove(entry)}>
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="button-row">
          <button type="button" className="button quiet" data-testid="sent-list-home" onClick={onStartOver}>
            Go to the start page
          </button>
        </div>
      </section>

      {emailing && (
        <EmailHandoff
          next={displayText(emailing.entry.next)}
          {...(emailing.entry.to ? { initialTo: emailing.entry.to } : {})}
          buildPacket={() => Promise.resolve(emailing.packet)}
          {...(emailing.entry.signedName ? { fileName: emailing.entry.signedName } : {})}
          onSent={(sent) => void emailedAgain(emailing.entry, sent)}
          onDownloadInstead={() => {
            const { entry, packet } = emailing;
            setEmailing(null);
            void download(entry, new TextEncoder().encode(packet));
          }}
          onClose={() => setEmailing(null)}
        />
      )}
    </main>
  );
}
