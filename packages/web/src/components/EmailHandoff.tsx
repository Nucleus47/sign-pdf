/**
 * "Email it to <next>": the first signer sends the hand-off to the next signer
 * through the relay (docs/relay.md). Steps: the next signer's address and an
 * optional password; a sign-in by email code when this tab has no relay
 * session; then encrypt, upload and send. Every network step has its own
 * waiting text, error and retry.
 *
 * Error reports never hold an email address or the key: each failure is a
 * fixed code with a fixed sentence (lib/relayClient.ts).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Email, RELAY_PASSPHRASE_MIN, RELAY_TTL_DAYS, RelayPassphrase } from '@sign-pdf/spec';
import { toCoreProblem } from '../lib/core.ts';
import { UNTRUSTED_TEXT_CLASS } from '../lib/displayText.ts';
import { failureOf, type Failure } from '../lib/errorReport.ts';
import { relayClient, RELAY_ERROR_TEXT, type RelayErrorCode, type RelaySession } from '../lib/relayClient.ts';
import { deliverHandoff, prepareHandoff, type PreparedHandoff } from '../lib/relaySend.ts';
import { loadTurnstile, NO_TURNSTILE_TOKEN } from '../lib/turnstile.ts';
import { Dialog } from './Dialog.tsx';
import { ErrorDetails } from './ErrorDetails.tsx';

export const PASSWORD_HINT = `B needs this passphrase; tell them separately. At least ${RELAY_PASSPHRASE_MIN} characters. It makes the document unreadable to anyone else, including this service. It also lets you collect the signed PDF on another device.`;

export interface EmailSent {
  id: string;
  to: string;
  expiresAt: string;
  /** False when this device could not keep the key for the signed PDF. */
  stored: boolean;
  /** The ciphertext that was uploaded, to keep for "Email it again" (lib/sentStore.ts). */
  blob: Uint8Array;
}

export interface EmailHandoffProps {
  /** The next signer, as the request names them (untrusted text). */
  next: string;
  /**
   * The next signer's address, when the sign view asked for it before this
   * panel opened. The panel then shows it and does not ask again.
   */
  address?: string;
  /** The hand-off packet text. Called once; the result is kept for retries. */
  buildPacket: () => Promise<string>;
  /** The file name for the signed PDF that comes back, kept on this device with the key. */
  fileName?: string;
  /** The address to start with, for "Email it again". */
  initialTo?: string;
  /**
   * Called with each newly encrypted hand-off before its upload, to keep its
   * key and ciphertext on this device (lib/sentStore.ts). Resolves to false
   * when they could not be kept.
   */
  onPrepared?: (prepared: PreparedHandoff) => Promise<boolean>;
  onSent: (sent: EmailSent) => void;
  onDownloadInstead: () => void;
  onClose: () => void;
}

type Step = 'recipient' | 'account' | 'code' | 'working';
type Work = 'preparing' | 'uploading' | 'sending';

interface Problem {
  text: string;
  failure: Failure;
  /** The input the problem is about, for aria-describedby. */
  field?: 'to' | 'password' | 'email' | 'code';
  /** Offer the hand-off PDF in its place. */
  download?: boolean;
  retry?: () => void;
}

const relayFailure = (code: RelayErrorCode, step: string): Failure => ({
  code: `relay-${code}`,
  message: `${step}: ${RELAY_ERROR_TEXT[code]}`,
});

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function EmailHandoff({
  next,
  address,
  buildPacket,
  fileName,
  initialTo = '',
  onPrepared,
  onSent,
  onDownloadInstead,
  onClose,
}: EmailHandoffProps) {
  const ids = useId();
  const client = relayClient();
  const [step, setStep] = useState<Step>('recipient');
  const [work, setWork] = useState<Work>('preparing');
  // `address` comes from the sign view and is shown as given; `initialTo` only prefills the field.
  const [to, setTo] = useState(address ?? initialTo);
  const given = address !== undefined && Email.safeParse(address).success;
  /** True once this device kept a copy to send again later. */
  const [keptCopy, setKeptCopy] = useState(false);
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);
  /** null while the relay's config is being read. */
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [token, setToken] = useState('');
  /** Counts loads of the Turnstile widget, so "Try again" loads it again. */
  const [widgetAttempt, setWidgetAttempt] = useState(0);
  const widgetBox = useRef<HTMLDivElement>(null);
  const widget = useRef<{ id: string; reset: () => void } | null>(null);
  const packet = useRef<Promise<string> | null>(null);
  const prepared = useRef<PreparedHandoff | null>(null);
  /** The password the kept blob was encrypted with (memory only), to know when to encrypt again. */
  const preparedPassword = useRef<string | undefined>(undefined);

  // The relay's config, read when the sign-in step opens: it says whether to show Turnstile.
  const readConfig = async () => {
    setSiteKey(null);
    const config = await client.config();
    if (config.ok) {
      setSiteKey(config.value.turnstileSiteKey);
      return;
    }
    setProblem({
      text: config.error,
      failure: relayFailure(config.code, 'config'),
      download: config.code === 'not-available',
      ...(config.code === 'not-available' ? {} : { retry: () => void readConfig() }),
    });
  };

  // Turnstile loads only here, when the person has asked to email and must sign in.
  useEffect(() => {
    if (step !== 'account' || !siteKey || !widgetBox.current) return;
    let removed = false;
    let widgetId: string | null = null;
    const box = widgetBox.current;
    loadTurnstile().then(
      (api) => {
        if (removed) return;
        widgetId = api.render(box, {
          sitekey: siteKey,
          callback: setToken,
          'expired-callback': () => setToken(''),
          'error-callback': () => setToken(''),
          size: 'flexible',
        });
        const id = widgetId;
        widget.current = { id, reset: () => api.reset(id) };
      },
      (error: unknown) => {
        if (removed) return;
        setProblem({
          text: 'The check before sign-in could not be loaded. Check your connection, then try again.',
          failure: failureOf(error, 'relay-turnstile'),
          retry: () => {
            setProblem(null);
            setWidgetAttempt((count) => count + 1);
          },
        });
      },
    );
    return () => {
      removed = true;
      if (widgetId !== null) window.turnstile?.remove(widgetId);
      widget.current = null;
      setToken('');
    };
  }, [step, siteKey, widgetAttempt]);

  /** To the sign-in step, with `reason` on screen (such as a sign-in that ran out). */
  const goToAccount = (reason: Problem | null = null) => {
    setProblem(reason);
    setStep('account');
    void readConfig();
  };

  /** Encrypt (once per address and password), upload (once), send. */
  const deliver = async (session: RelaySession) => {
    setStep('working');
    setProblem(null);
    const secret = password === '' ? undefined : password;
    try {
      const address = Email.parse(to);
      const kept = prepared.current;
      if (!kept || kept.to !== address || preparedPassword.current !== secret || kept.expiresAt === undefined) {
        setWork('preparing');
        packet.current ??= buildPacket();
        const text = await packet.current;
        const result = await prepareHandoff(text, address, secret);
        if (!result.ok) {
          prepared.current = null;
          setStep('recipient');
          setProblem({
            text: `Too large to email. Download the PDF for ${next} instead.`,
            failure: relayFailure('too-large', 'encrypt'),
            download: true,
          });
          return;
        }
        prepared.current = result.prepared;
        preparedPassword.current = secret;
        // Kept before the upload, so a failed send survives a reload.
        if (onPrepared) setKeptCopy(await onPrepared(result.prepared));
      }
      const current = prepared.current;
      if (!current) return;
      setWork(current.expiresAt === undefined ? 'uploading' : 'sending');
      const result = await deliverHandoff(
        {
          ...client,
          // The text on screen follows the request that is running.
          send: (...args) => {
            setWork('sending');
            return client.send(...args);
          },
        },
        session,
        current,
        storage(),
        fileName,
      );
      if (result.ok) {
        prepared.current = null;
        preparedPassword.current = undefined;
        onSent({ id: result.id, to: address, expiresAt: result.expiresAt, stored: result.stored, blob: current.blob });
        return;
      }
      if (result.code === 'unauthorized') {
        goToAccount({ text: result.error, failure: relayFailure(result.code, result.step) });
        return;
      }
      // The upload cannot be used again: a new id and a new upload on retry.
      if (result.code === 'id-taken' || result.code === 'not-found') prepared.current = null;
      setProblem({
        text: result.error,
        failure: relayFailure(result.code, result.step),
        download: result.code === 'too-large' || result.code === 'not-available',
        ...(result.code === 'too-large' || result.code === 'not-available'
          ? {}
          : { retry: () => void deliver(session) }),
      });
    } catch (error) {
      packet.current = null;
      prepared.current = null;
      const failure = error instanceof TypeError ? failureOf(error, 'relay-encrypt') : toCoreProblem(error);
      setProblem({
        text: 'The document could not be prepared for email. Try again, or download the PDF instead.',
        failure,
        download: true,
        retry: () => void deliver(session),
      });
    }
  };

  const submitRecipient = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (!Email.safeParse(to).success) {
      setProblem({
        text: `Enter ${next}'s email address, such as name@example.com.`,
        failure: { code: 'relay-bad-address', message: 'The address is not an email address.' },
        field: 'to',
      });
      return;
    }
    if (password !== '' && !RelayPassphrase.safeParse(password).success) {
      setProblem({
        text: `The passphrase needs at least ${RELAY_PASSPHRASE_MIN} characters. Leave it empty for none.`,
        failure: { code: 'relay-short-passphrase', message: 'The passphrase is too short or too long.' },
        field: 'password',
      });
      return;
    }
    setProblem(null);
    const session = client.currentSession();
    if (session) void deliver(session);
    else goToAccount();
  };

  const submitAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || siteKey === null) return;
    if (!Email.safeParse(email).success) {
      setProblem({
        text: 'Enter your email address, such as name@example.com.',
        failure: { code: 'relay-bad-address', message: 'The address is not an email address.' },
        field: 'email',
      });
      return;
    }
    if (siteKey && !token) {
      setProblem({
        text: 'Complete the check above, then ask for the code again.',
        failure: { code: 'relay-turnstile-missing', message: 'No Turnstile token.' },
      });
      return;
    }
    setPending(true);
    setProblem(null);
    const result = await client.login(Email.parse(email), siteKey ? token : NO_TURNSTILE_TOKEN);
    setPending(false);
    // A token works once.
    widget.current?.reset();
    setToken('');
    if (!result.ok) {
      setProblem({ text: result.error, failure: relayFailure(result.code, 'login') });
      return;
    }
    setCode('');
    setStep('code');
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const digits = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setProblem({
        text: 'Enter the 6 digits from the email.',
        failure: { code: 'relay-bad-code-format', message: 'The code is not 6 digits.' },
        field: 'code',
      });
      return;
    }
    setPending(true);
    setProblem(null);
    const result = await client.verify(Email.parse(email), digits);
    setPending(false);
    if (!result.ok) {
      setProblem({
        text: result.error,
        failure: relayFailure(result.code, 'verify'),
        ...(result.code === 'bad-code' ? { field: 'code' as const } : {}),
      });
      return;
    }
    void deliver(result.value);
  };

  const errorId = `${ids}-error`;
  const invalid = (field: Problem['field']) =>
    problem?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};

  const problemBox = problem && (
    <div className="form-error" role="alert" id={errorId} data-testid="email-error">
      <p>{problem.text}</p>
      <ErrorDetails failure={problem.failure} />
    </div>
  );

  const downloadInstead = (
    <button
      type="button"
      className={problem?.download ? 'button primary' : 'button quiet'}
      data-testid="email-download-instead"
      onClick={onDownloadInstead}
    >
      Download PDF instead
    </button>
  );

  const workText: Record<Work, string> = {
    preparing: 'Encrypting the document on this device…',
    uploading: 'Uploading the encrypted document…',
    sending: `Emailing ${next}…`,
  };

  return (
    // While a request runs, the dialog stays open: its answer must reach the screen.
    <Dialog
      title={`Email it to ${next}`}
      onClose={() => {
        if ((step !== 'working' || problem) && !pending) onClose();
      }}
      testId="email-handoff-dialog"
    >
      {step === 'recipient' && (
        <form className="email-form" onSubmit={submitRecipient} noValidate data-testid="email-recipient">
          <p className="hint">
            <span className={UNTRUSTED_TEXT_CLASS}>{next}</span> gets a link that works for {RELAY_TTL_DAYS} days. The document is encrypted on this device
            before it is uploaded.
          </p>
          {given ? (
            <p data-testid="email-to-given">
              To <strong>{Email.parse(to)}</strong>
            </p>
          ) : (
          <div className="form-item">
            <label htmlFor={`${ids}-to`}>
              Email address of <span className={UNTRUSTED_TEXT_CLASS}>{next}</span>
            </label>
            <input
              id={`${ids}-to`}
              className="input"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              maxLength={254}
              required
              data-autofocus
              data-testid="email-to"
              value={to}
              onChange={(event) => {
                prepared.current = null;
                setTo(event.target.value);
              }}
              {...invalid('to')}
            />
          </div>
          )}
          <div className="form-item">
            <label htmlFor={`${ids}-password`}>
              Passphrase (optional)
            </label>
            <input
              id={`${ids}-password`}
              className="input"
              type="password"
              autoComplete="new-password"
              maxLength={200}
              aria-describedby={problem?.field === 'password' ? `${errorId} ${ids}-password-hint` : `${ids}-password-hint`}
              aria-invalid={problem?.field === 'password' || undefined}
              data-testid="email-password"
              value={password}
              onChange={(event) => {
                prepared.current = null;
                setPassword(event.target.value);
              }}
            />
            <p className="hint" id={`${ids}-password-hint`}>
              <span className={UNTRUSTED_TEXT_CLASS}>{next}</span> {PASSWORD_HINT.replace(/^B /, '')}
            </p>
          </div>
          {problemBox}
          <div className="email-actions">
            {downloadInstead}
            {!problem?.download && (
              <button type="submit" className="button primary" data-testid="email-continue" data-autofocus={given || undefined}>
                {client.currentSession() ? 'Send email' : 'Continue'}
              </button>
            )}
          </div>
        </form>
      )}

      {step === 'account' && (
        <form className="email-form" onSubmit={(event) => void submitAccount(event)} noValidate data-testid="email-account">
          <p>Sign in with your own email address first. You get a 6-digit code. The sign-in lasts 24 hours in this tab.</p>
          <div className="form-item">
            <label htmlFor={`${ids}-email`}>Your email address</label>
            <input
              id={`${ids}-email`}
              className="input"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              maxLength={254}
              required
              data-autofocus
              data-testid="email-own"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              {...invalid('email')}
            />
          </div>
          {siteKey === null && !problem && (
            <p className="hint" role="status">
              Connecting to the email service…
            </p>
          )}
          {siteKey && <div className="turnstile-box" ref={widgetBox} data-testid="turnstile" />}
          {problemBox}
          <div className="email-actions">
            <button type="button" className="button quiet" data-testid="email-back" onClick={() => {
                setProblem(null);
                setStep('recipient');
              }}>
              Back
            </button>
            {problem?.retry && !pending ? (
              <button type="button" className="button primary" data-testid="email-retry" onClick={problem.retry}>
                Try again
              </button>
            ) : problem?.download ? (
              downloadInstead
            ) : (
              <button
                type="submit"
                className="button primary"
                data-testid="email-send-code"
                disabled={pending || siteKey === null}
              >
                {pending ? 'Sending the code…' : 'Email me a code'}
              </button>
            )}
          </div>
        </form>
      )}

      {step === 'code' && (
        <form className="email-form" onSubmit={(event) => void submitCode(event)} noValidate data-testid="email-code">
          <p>
            Enter the 6-digit code sent to <strong>{email.trim()}</strong>. It works for 10 minutes.
          </p>
          <div className="form-item">
            <label htmlFor={`${ids}-code`}>Code</label>
            <input
              id={`${ids}-code`}
              className="input code-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={8}
              required
              data-autofocus
              data-testid="email-code-input"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              {...invalid('code')}
            />
          </div>
          {problemBox}
          <div className="email-actions">
            <button type="button" className="button quiet" data-testid="email-new-code" onClick={() => goToAccount()}>
              Send a new code
            </button>
            <button type="submit" className="button primary" data-testid="email-verify" disabled={pending}>
              {pending ? 'Signing in…' : 'Sign in and send'}
            </button>
          </div>
        </form>
      )}

      {step === 'working' && (
        <div className="email-form" data-testid="email-working">
          {!problem && (
            <p role="status" className="email-progress" data-testid="email-progress">
              {workText[work]}
            </p>
          )}
          {problemBox}
          {problem && keptCopy && (
            <p className="hint" data-testid="email-kept">
              A copy stays on this device. You can email it again later from “Documents you sent” on the start page.
            </p>
          )}
          {problem && (
            <div className="email-actions">
              {downloadInstead}
              {problem.retry && (
                <button type="button" className="button primary" data-testid="email-retry" onClick={problem.retry}>
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
