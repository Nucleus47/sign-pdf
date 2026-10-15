/**
 * The first signer collects the signed PDF (issue #71) from the return link
 * `#relay=<id>`. Nothing is fetched until the person submits the code from
 * the email, so a link scanner that loads the page uses no attempt. The
 * fetched ciphertext is kept in memory, so a wrong password can be corrected
 * without using another code attempt. The relay copy is deleted only once the
 * download was handed to the browser.
 *
 * On a device that did not send the document (no kept key), the card asks for
 * the code and the passphrase. The relay hands back the key wrapped with the
 * passphrase, and this device unwraps it (issue #105). Without a wrapped key
 * (no passphrase was set), the card says to open the link on the device that
 * sent, or to ask the other signer.
 */
import { useId, useRef, useState, type FormEvent } from 'react';
import { ErrorDetails } from '../components/ErrorDetails.tsx';
import { CheckMark } from '../components/FieldCanvas.tsx';
import type { Failure } from '../lib/errorReport.ts';
import { downloadFile } from '../lib/files.ts';
import { relayClient } from '../lib/relayClient.ts';
import {
  CODE_PATTERN,
  RELAY_FINAL_FALLBACK_NAME,
  decryptRelayFinal,
  fetchRelayFinal,
  unwrapRelayKey,
} from '../lib/relayCollect.ts';
import { loadRelayEntry, removeRelayEntry, type RelayEntry } from '../lib/relayStore.ts';
import { forgetCollected } from '../lib/sentStore.ts';
import { UNTRUSTED_TEXT_CLASS, displayText } from '../lib/displayText.ts';

export interface RelayCollectProps {
  /** The document id from the return link. */
  id: string;
  onStartOver: () => void;
}

interface Problem {
  text: string;
  failure: Failure;
  field?: 'code' | 'password';
}

function deviceStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function RelayCollect({ id, onStartOver }: RelayCollectProps) {
  const ids = useId();
  // Read once: the entry is removed after the download.
  const [entry] = useState<RelayEntry | null>(() => loadRelayEntry(deviceStorage(), id));
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState<{ pdf: Uint8Array; name: string; deleted: boolean } | null>(null);
  /** True once the relay answered without a wrapped key, on a device without the kept key. */
  const [noWrappedKey, setNoWrappedKey] = useState(false);
  const fetched = useRef<{ blob: Uint8Array; wrappedKey?: string } | null>(null);
  /** No key on this device: the passphrase unwraps the one the relay keeps. */
  const remote = entry === null;

  if (noWrappedKey && !saved) {
    return (
      <main className="centered" id="main">
        <section className="card narrow relay-collect" data-testid="relay-collect-nokey" aria-labelledby={`${ids}-title`}>
          <h1 id={`${ids}-title`}>Open this link on the device you sent from</h1>
          <p className="lede">
            No passphrase was set when the document was sent, so only the device that emailed it can open the signed
            copy. Open this link there, or ask the other signer for the PDF; they downloaded a copy.
          </p>
          <div className="button-row">
            <button type="button" className="button quiet" data-testid="relay-collect-home" onClick={onStartOver}>
              Go to the start page
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (saved) {
    return (
      <main className="centered" id="main">
        <section className="card narrow relay-collect" data-testid="relay-collect-done" aria-labelledby={`${ids}-title`}>
          <h1 id={`${ids}-title`} className="relay-collect-done" tabIndex={-1}>
            <CheckMark className="check-icon" />
            <span>Downloaded</span>
          </h1>
          <p className={`doc-name ${UNTRUSTED_TEXT_CLASS}`}>{saved.name}</p>
          <p className="lede" role="status" data-testid="relay-collect-status">
            {saved.deleted
              ? 'The copy on the server is deleted.'
              : 'The copy on the server could not be deleted now. The server deletes it when it expires.'}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button"
              data-testid="relay-collect-again"
              onClick={() => downloadFile(saved.name, saved.pdf, 'application/pdf')}
            >
              Download again
            </button>
            <button type="button" className="button quiet" data-testid="relay-collect-home" onClick={onStartOver}>
              Go to the start page
            </button>
          </div>
        </section>
      </main>
    );
  }

  /** The kept entry asks for the password only when one was set; on another device, the passphrase is always needed. */
  const needsPassword = remote || entry.p;
  const fail = (text: string, code: string, field?: Problem['field'], message: string = code) =>
    setProblem({ text, failure: { code, message }, ...(field ? { field } : {}) });

  const collect = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const typed = code;
    if (!fetched.current && !CODE_PATTERN.test(typed)) {
      fail('Enter the 6-digit code from the email.', 'relay-code-missing', 'code');
      return;
    }
    if (needsPassword && password === '') {
      fail(remote ? 'Enter the passphrase.' : 'Enter the password.', 'relay-password-missing', 'password');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      if (!fetched.current) {
        const got = await fetchRelayFinal(relayClient(), id, typed);
        if (!got.ok) {
          const message = got.status === undefined ? got.code : `${got.code} (HTTP ${got.status})`;
          fail(got.message, got.code, got.code === 'bad-code' ? 'code' : undefined, message);
          return;
        }
        fetched.current = got.wrappedKey === undefined ? { blob: got.blob } : { blob: got.blob, wrappedKey: got.wrappedKey };
      }
      const secret = needsPassword ? password : undefined;
      let kept: Pick<RelayEntry, 'k' | 'n'>;
      if (entry) {
        kept = entry;
      } else {
        const wrapped = fetched.current.wrappedKey;
        if (wrapped === undefined) {
          // Nothing on the server can open it: the code still works on the device that sent.
          fetched.current = null;
          setNoWrappedKey(true);
          return;
        }
        // On this device only: a wrong passphrase uses no code attempt.
        const unwrapped = await unwrapRelayKey(id, wrapped, password);
        if (!unwrapped.ok) {
          fail(unwrapped.message, unwrapped.code, unwrapped.code === 'relay-unwrap-failed' ? 'password' : undefined);
          return;
        }
        kept = unwrapped.entry;
      }
      const opened = await decryptRelayFinal(id, kept, fetched.current.blob, secret);
      if (!opened.ok) {
        fail(opened.message, opened.code, opened.code === 'relay-decrypt-failed' && secret !== undefined ? 'password' : undefined);
        return;
      }
      const name = kept.n ? displayText(kept.n) : RELAY_FINAL_FALLBACK_NAME;
      try {
        downloadFile(name, opened.pdf, 'application/pdf');
      } catch {
        fail('The download did not start. Try again.', 'relay-download-failed');
        return;
      }
      // Saved: delete the relay copy. A failure is not retried; the relay's expiry removes it.
      const deleted = await relayClient()
        .deleteDoc(id)
        .then((result) => result.ok)
        .catch(() => false);
      removeRelayEntry(deviceStorage(), id);
      // The kept hand-off is no longer needed: nothing is left to send again.
      void forgetCollected(id);
      fetched.current = null;
      setSaved({ pdf: opened.pdf, name, deleted });
    } finally {
      setBusy(false);
    }
  };

  const errorId = `${ids}-error`;
  const invalid = (field: Problem['field']) =>
    problem?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};
  return (
    <main className="centered" id="main">
      <section className="card narrow relay-collect" data-testid="relay-collect" aria-labelledby={`${ids}-title`}>
        <h1 id={`${ids}-title`}>Your signed document is ready</h1>
        <p className="lede">
          {remote
            ? 'Enter the code from the email and the passphrase you set when you sent the document. It is decrypted on this device.'
            : 'It is decrypted on this device. The server keeps only an encrypted copy.'}
        </p>
        {remote && (
          <p className="hint" data-testid="relay-collect-nopass">
            If you set no passphrase, open this link on the device you sent from, or ask the other signer for the PDF.
            They downloaded a copy.
          </p>
        )}
        <form className="email-form" onSubmit={(event) => void collect(event)} noValidate>
          {!fetched.current && (
            <div className="form-item">
              <label htmlFor={`${ids}-code`}>Code</label>
              <input
                id={`${ids}-code`}
                className="input code-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                required
                data-testid="relay-collect-code"
                value={code}
                // Digits only, so a pasted "123 456" works.
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                aria-describedby={`${ids}-code-hint`}
                {...invalid('code')}
              />
              <p className="hint" id={`${ids}-code-hint`}>
                The code is in the email.
              </p>
            </div>
          )}
          {needsPassword && (
            <div className="form-item">
              <label htmlFor={`${ids}-password`}>{remote ? 'Passphrase' : 'Password'}</label>
              <input
                id={`${ids}-password`}
                className="input"
                type="password"
                autoComplete="off"
                maxLength={200}
                required
                data-testid="relay-collect-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={`${ids}-password-hint`}
                {...invalid('password')}
              />
              <p className="hint" id={`${ids}-password-hint`}>
                {remote
                  ? 'The passphrase you set when you sent it. A wrong passphrase does not use a code attempt.'
                  : 'The password you set when you emailed the document.'}
              </p>
            </div>
          )}
          {problem && (
            <div className="form-error" role="alert" id={errorId} data-testid="relay-collect-error" data-code={problem.failure.code}>
              <p>{problem.text}</p>
              <ErrorDetails failure={problem.failure} />
            </div>
          )}
          <div className="button-row">
            <button type="submit" className="button primary" data-testid="relay-collect-button" disabled={busy}>
              {busy ? 'Downloading…' : 'Download'}
            </button>
            {problem && !problem.field && (
              <button type="button" className="button quiet" data-testid="relay-collect-home" onClick={onStartOver}>
                Go to the start page
              </button>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}
