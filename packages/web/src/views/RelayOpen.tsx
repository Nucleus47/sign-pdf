/**
 * The next signer opens an emailed document (issue #65). Nothing is fetched
 * until the person taps Open, so a link scanner that loads the page uses
 * nothing up. The fetched ciphertext is kept in memory, so a wrong password can
 * be corrected without asking the relay again.
 */
import { useId, useRef, useState, type FormEvent } from 'react';
import { openRelayPacket, type Opened, type SignJob } from '../app/open.ts';
import { ErrorDetails } from '../components/ErrorDetails.tsx';
import type { Failure } from '../lib/errorReport.ts';
import { relayClient, type FetchedHandoff } from '../lib/relayClient.ts';
import type { RelayLink } from '../lib/relayLink.ts';
import { decryptRelayHandoff, fetchRelayHandoff } from '../lib/relayOpen.ts';

export interface RelayOpenProps {
  /** A link with a key: the next signer's. */
  link: RelayLink & { key: string };
  onOpened: (job: SignJob) => void;
  onStartOver: () => void;
}

interface Problem {
  text: string;
  failure: Failure;
  /** True when the password field is what to fix. */
  password?: boolean;
}

export function RelayOpen({ link, onOpened, onStartOver }: RelayOpenProps) {
  const ids = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const fetched = useRef<FetchedHandoff | null>(null);
  // The relay can say a password is set even when the link lost its `p=1`.
  const [needsPassword, setNeedsPassword] = useState(link.password);

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (needsPassword && password === '') {
      setProblem({ text: 'Enter the password.', failure: { code: 'relay-password-missing', message: 'relay-password-missing' }, password: true });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      if (!fetched.current) {
        const got = await fetchRelayHandoff(relayClient(), link.id);
        if (!got.ok) {
          const message = got.status === undefined ? got.code : `${got.code} (HTTP ${got.status})`;
          setProblem({ text: got.message, failure: { code: got.code, message } });
          return;
        }
        fetched.current = got.fetched;
        // Once fetched, the relay's flag decides: the link's `p=1` can be lost or wrong.
        setNeedsPassword(got.fetched.password);
        if (got.fetched.password && password === '') {
          setProblem({ text: 'This document has a password. Enter it.', failure: { code: 'relay-password-missing', message: 'relay-password-missing' }, password: true });
          return;
        }
      }
      const secret = fetched.current.password ? password : undefined;
      const decrypted = await decryptRelayHandoff(link.id, link.key, fetched.current.blob, secret);
      if (!decrypted.ok) {
        setProblem({
          text: decrypted.message,
          failure: { code: decrypted.code, message: decrypted.code },
          password: decrypted.code === 'relay-decrypt-failed' && secret !== undefined,
        });
        return;
      }
      const opened: Opened = await openRelayPacket({ id: link.id, docKey: decrypted.docKey }, decrypted.plaintext);
      if (opened.kind === 'sign') {
        onOpened(opened.job);
        return;
      }
      if (opened.kind === 'error') setProblem({ text: opened.message, failure: opened.failure });
    } finally {
      setBusy(false);
    }
  };

  const errorId = `${ids}-error`;
  return (
    <main className="centered" id="main">
      <section className="card narrow relay-open" data-testid="relay-open" aria-labelledby={`${ids}-title`}>
        <h1 id={`${ids}-title`}>Open the document</h1>
        <p className="lede">Someone asked you to sign a document. It is decrypted on this device.</p>
        <form className="email-form" onSubmit={(event) => void open(event)} noValidate>
          {needsPassword && (
            <div className="form-item">
              <label htmlFor={`${ids}-password`}>Password</label>
              <input
                id={`${ids}-password`}
                className="input"
                type="password"
                autoComplete="off"
                maxLength={200}
                required
                data-testid="relay-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={problem?.password ? errorId : `${ids}-password-hint`}
                {...(problem?.password ? { 'aria-invalid': true as const } : {})}
              />
              <p className="hint" id={`${ids}-password-hint`}>
                The person who sent the email gives you the password separately.
              </p>
            </div>
          )}
          {problem && (
            <div className="form-error" role="alert" id={errorId} data-testid="relay-open-error" data-code={problem.failure.code}>
              <p>{problem.text}</p>
              <ErrorDetails failure={problem.failure} />
            </div>
          )}
          <div className="button-row">
            <button type="submit" className="button primary" data-testid="relay-open-button" disabled={busy}>
              {busy ? 'Opening…' : 'Open'}
            </button>
            {problem && !problem.password && (
              <button type="button" className="button quiet" data-testid="relay-open-home" onClick={onStartOver}>
                Go to the start page
              </button>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}
