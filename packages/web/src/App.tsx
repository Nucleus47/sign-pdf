import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { SignRequestInput } from '@sign-pdf/spec';
import {
  DOC_STATE_TEXT,
  hasWorkToLose,
  openFiles,
  openPacketText,
  openPdfWithRequest,
  openSample,
  type DocState,
  type LoadedDocument,
  type Opened,
  type SignJob,
} from './app/open.ts';
import { Dialog } from './components/Dialog.tsx';
import { ErrorDetails } from './components/ErrorDetails.tsx';
import { failureOf } from './lib/errorReport.ts';
import { resetUncaught } from './lib/lastError.ts';
import { emptyPrepareState, prepareReducer } from './lib/fields.ts';
import { fetchSessionPacket, openSession, type SessionProblem } from './lib/transport.ts';
import { Home, type HomeError } from './views/Home.tsx';
import { Prepare } from './views/Prepare.tsx';
import { RelayCollect } from './views/RelayCollect.tsx';
import { RelayOpen } from './views/RelayOpen.tsx';
import { SentList } from './views/SentList.tsx';
import { listSentHandoffs } from './lib/sentStore.ts';
import { useRelayAvailable } from './lib/useRelayAvailable.ts';
import type { RelayLink } from './lib/relayLink.ts';
import type { RequestLink } from './lib/requestLink.ts';
import { Sign } from './views/Sign.tsx';
import { Verify } from './views/Verify.tsx';
import { APP_BAR_SLOT_ID } from './lib/dom.ts';

type Screen =
  | { view: 'home' }
  | { view: 'connecting' }
  /** The signing link cannot be used, and asking again does not help. */
  | { view: 'link-problem'; problem: Exclude<SessionProblem, 'unreachable'>; reason: string }
  /** An emailed document's link: one tap opens it. */
  | { view: 'relay-open'; link: RelayLink & { key: string } }
  /** The first signer's return link: collect the signed PDF with the code from the email. */
  | { view: 'relay-collect'; id: string }
  | { view: 'prepare'; document: LoadedDocument }
  | { view: 'sign'; job: SignJob }
  | { view: 'verify' }
  /** The hand-offs this device emailed, to send again (issue #98). */
  | { view: 'sent' };

/**
 * A signing link works once and the session token lives in this tab's memory
 * only, so a reload or a finished command cannot be resumed: say how to get a new link.
 */
const NEW_LINK =
  'A signing link works once, and only while the command that made it is waiting. If you reloaded this page or the command has ended, run the command again to get a new link.';

export interface AppProps {
  /** One-time loopback session nonce read from the URL at startup; null on the hosted site. */
  sessionNonce: string | null;
  /** True when this tab was opened with a signing link and then reloaded: the session cannot resume. */
  sessionLinkReloaded?: boolean;
  /** A relay link read from the URL at startup (issue #65); the key is in memory only. */
  relayLink?: RelayLink | null;
  /** A request from a #request= link (issue #45), put on the page when a PDF opens in prepare. */
  requestLink?: RequestLink | null;
}

const REQUEST_WAITING = 'An agent’s request is waiting. Open the PDF it was written for, and its fields go on the page for you to check.';

export function App({ sessionNonce, sessionLinkReloaded = false, relayLink = null, requestLink = null }: AppProps) {
  const [screen, setScreen] = useState<Screen>(() =>
    sessionNonce
      ? { view: 'connecting' }
      : relayLink && relayLink.key !== undefined
        ? { view: 'relay-open', link: { ...relayLink, key: relayLink.key } }
      : relayLink
        ? { view: 'relay-collect', id: relayLink.id }
      : sessionLinkReloaded
        ? { view: 'link-problem', problem: 'not-valid', reason: 'This page was reloaded, and a signing link works only once.' }
        : { view: 'home' },
  );
  /** The session token: memory only, and not in React state, so no tool or log shows it. */
  const sessionToken = useRef<string | null>(null);
  const [prepareDocument, setPrepareDocument] = useState<LoadedDocument | null>(null);
  const [prepare, dispatch] = useReducer(prepareReducer, emptyPrepareState);
  const [signState, setSignState] = useState<DocState>('opening');
  /** Why the session packet did not arrive in time; the person can ask again. */
  const [connectProblem, setConnectProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HomeError | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    requestLink === null ? null : requestLink.ok ? REQUEST_WAITING : requestLink.error,
  );
  /** The link's request until a PDF opens in prepare; memory only. */
  const [pendingRequest, setPendingRequest] = useState<unknown>(() => (requestLink?.ok ? requestLink.request : undefined));
  const clearPendingRequest = useCallback(() => setPendingRequest(undefined), []);
  const [leaveTo, setLeaveTo] = useState<'home' | 'verify' | null>(null);
  const started = useRef(false);
  /** True when this device keeps documents it emailed: the start page links to them while the relay is on. */
  const [hasSent, setHasSent] = useState(false);
  /** True when this server offers email hand-off: the start page describes it. */
  const relayAvailable = useRelayAvailable(screen.view === 'home');

  const docState: DocState =
    screen.view === 'prepare'
      ? 'preparing'
      : screen.view === 'sign'
        ? signState
        : screen.view === 'connecting' && !connectProblem
          ? 'opening'
          : 'empty';

  const show = useCallback((opened: Opened) => {
    if (opened.kind === 'error') {
      setError({ message: opened.message, failure: opened.failure, ...(opened.file ? { file: opened.file } : {}) });
      setScreen({ view: 'home' });
      return;
    }
    setError(null);
    setNotice(null);
    if (opened.kind === 'prepare') {
      dispatch({ type: 'reset' });
      setPrepareDocument(opened.document);
      setScreen({ view: 'prepare', document: opened.document });
    } else {
      setSignState('opening');
      setScreen({ view: 'sign', job: opened.job });
    }
  }, []);

  const run = useCallback(
    async (work: () => Promise<Opened>) => {
      setBusy(true);
      setError(null);
      try {
        show(await work());
      } catch (failure) {
        setError({
          message: `The file could not be opened. (${failure instanceof Error ? failure.message : String(failure)})`,
          failure: failureOf(failure),
        });
      } finally {
        setBusy(false);
      }
    },
    [show],
  );

  // Loopback session: only when the page was opened with a session nonce.
  // The nonce is exchanged for the token once; the token stays in memory, so
  // the packet can be asked for again when the local app did not answer.
  const connect = useCallback(async () => {
    if (!sessionNonce) return;
    setConnectProblem(null);
    if (sessionToken.current === null) {
      const opened = await openSession(sessionNonce);
      if (!opened.ok) {
        if (opened.problem === 'unreachable') setConnectProblem(opened.reason);
        else setScreen({ view: 'link-problem', problem: opened.problem, reason: opened.reason });
        return;
      }
      sessionToken.current = opened.token;
    }
    const token = sessionToken.current;
    const session = await fetchSessionPacket(token);
    if (session.active) {
      show(await openPacketText(session.packetText, token));
      return;
    }
    if (session.problem === 'unreachable') setConnectProblem(session.reason);
    else setScreen({ view: 'link-problem', problem: 'not-valid', reason: session.reason });
  }, [sessionNonce, show]);

  useEffect(() => {
    if (!sessionNonce || started.current) return;
    started.current = true;
    void connect();
  }, [sessionNonce, connect]);

  // Move focus to the new view's heading so keyboard and screen-reader users land in it.
  const view = screen.view;
  const firstPaint = useRef(true);
  useEffect(() => {
    if (firstPaint.current) {
      firstPaint.current = false;
      return;
    }
    const heading = document.querySelector<HTMLElement>('#main h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [view, signState]);

  // Read again each time the start page shows: a send or a collect changes it.
  useEffect(() => {
    if (view !== 'home') return;
    let current = true;
    void listSentHandoffs().then((entries) => {
      if (current) setHasSent(entries.length > 0);
    });
    return () => {
      current = false;
    };
  }, [view]);

  const go = (target: 'home' | 'verify' | 'sent') => {
    resetUncaught();
    setLeaveTo(null);
    setError(null);
    setScreen({ view: target });
  };

  const requestLeave = (target: 'home' | 'verify') => {
    if (hasWorkToLose(screen.view, prepare.fields.length, signState)) setLeaveTo(target);
    else go(target);
  };

  const continueToSign = (request: SignRequestInput) => {
    if (screen.view !== 'prepare') return;
    setSignState('opening');
    setScreen({
      view: 'sign',
      job: {
        document: { name: screen.document.name, bytes: screen.document.bytes },
        request,
        origin: 'prepare',
      },
    });
  };

  const signJob = screen.view === 'sign' ? screen.job : null;

  return (
    <div className="app" data-testid="app-root" data-state={docState} data-view={screen.view}>
      <a className="skip-link" href="#main">
        Skip to the content
      </a>
      <header className="app-bar">
        <button type="button" className="brand" data-testid="nav-home" onClick={() => requestLeave('home')}>
          <span className="brand-mark" aria-hidden="true" />
          <span>sign-pdf</span>
        </button>
        <p className="visually-hidden" role="status" aria-live="polite" data-testid="doc-state">
          {DOC_STATE_TEXT[docState]}
        </p>
        <nav aria-label="Site">
          {/* A view can put its own control here. */}
          <div id={APP_BAR_SLOT_ID} className="app-bar-slot" />
        </nav>
      </header>

      {screen.view === 'home' && (
        <Home
          busy={busy}
          error={error}
          notice={notice}
          onFiles={(files) => void run(() => openFiles(files))}
          onPdfWithRequest={(pdf, request) => void run(() => openPdfWithRequest(pdf, request))}
          onSample={() => void run(openSample)}
          onVerify={() => go('verify')}
          relay={relayAvailable}
          {...(hasSent && relayAvailable ? { onSentList: () => go('sent') } : {})}
        />
      )}

      {screen.view === 'connecting' && (
        <main className="centered" id="main">
          <h1>Opening your document</h1>
          {connectProblem ? (
            <section className="card narrow" role="alert" data-testid="connect-problem">
              <p>
                The document did not arrive. {connectProblem} Check that the requesting app is
                still running, then try again.
              </p>
              <p>{NEW_LINK}</p>
              <div className="button-row">
                <button type="button" className="button primary" data-testid="connect-retry" onClick={() => void connect()}>
                  Try again
                </button>
                <button type="button" className="button" data-testid="connect-give-up" onClick={() => go('home')}>
                  Go to the start page
                </button>
              </div>
              <ErrorDetails failure={{ code: 'session-unreachable', message: connectProblem }} />
            </section>
          ) : (
            <p role="status">Getting the document from the requesting app…</p>
          )}
        </main>
      )}

      {screen.view === 'link-problem' && (
        <main className="centered" id="main">
          {screen.problem === 'already-opened' ? (
            <>
              <h1>This signing link was already opened</h1>
              <section className="card narrow" role="alert" data-testid="link-problem" data-problem={screen.problem}>
                <p>
                  This signing link was already opened, in another tab or by another program. Ask
                  the app that sent it to start again; do not sign if you did not open it yourself.
                </p>
                <p>{NEW_LINK}</p>
                <ErrorDetails failure={{ code: screen.problem, message: screen.reason }} />
              </section>
            </>
          ) : (
            <>
              <h1>This signing link is no longer valid</h1>
              <section className="card narrow" role="alert" data-testid="link-problem" data-problem={screen.problem}>
                <p>
                  {screen.reason} Ask the app that sent the link to start a new signature request.
                </p>
                <p>{NEW_LINK}</p>
                <div className="button-row">
                  <button type="button" className="button" data-testid="link-problem-home" onClick={() => go('home')}>
                    Go to the start page
                  </button>
                </div>
                <ErrorDetails failure={{ code: screen.problem, message: screen.reason }} />
              </section>
            </>
          )}
        </main>
      )}

      {screen.view === 'relay-open' && (
        <RelayOpen
          link={screen.link}
          onOpened={(job) => {
            setSignState('opening');
            setScreen({ view: 'sign', job });
          }}
          onStartOver={() => go('home')}
        />
      )}

      {screen.view === 'relay-collect' && <RelayCollect id={screen.id} onStartOver={() => go('home')} />}

      {screen.view === 'prepare' && (
        <Prepare
          document={screen.document}
          state={prepare}
          dispatch={dispatch}
          onContinue={continueToSign}
          {...(pendingRequest !== undefined ? { initialRequest: pendingRequest, onInitialRequestUsed: clearPendingRequest } : {})}
        />
      )}

      {signJob && (
        <Sign
          job={signJob}
          onDocState={setSignState}
          {...(signJob.origin === 'prepare' && prepareDocument
            ? { onBackToPrepare: () => setScreen({ view: 'prepare', document: prepareDocument }) }
            : {})}
          onStartOver={(message) => {
            resetUncaught();
            setNotice(message ?? null);
            setError(null);
            setScreen({ view: 'home' });
          }}
        />
      )}

      {screen.view === 'verify' && <Verify />}

      {screen.view === 'sent' && <SentList onStartOver={() => go('home')} />}

      {leaveTo && (
        <Dialog
          title="Leave this document?"
          onClose={() => setLeaveTo(null)}
          testId="leave-dialog"
          footer={
            <>
              <button type="button" className="button" data-testid="leave-cancel" data-autofocus="" onClick={() => setLeaveTo(null)}>
                Stay
              </button>
              <button type="button" className="button danger" data-testid="leave-confirm" onClick={() => go(leaveTo)}>
                Leave
              </button>
            </>
          }
        >
          <p>
            The fields and values you entered are kept only in this tab. If you leave now, they are
            lost.
          </p>
        </Dialog>
      )}
    </div>
  );
}
