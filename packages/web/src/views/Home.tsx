import { useId, useRef, useState, type DragEvent } from 'react';
import { RELAY_TTL_DAYS } from '@sign-pdf/spec';
import { ErrorDetails } from '../components/ErrorDetails.tsx';
import type { Failure, FileFacts } from '../lib/errorReport.ts';

/** Why the last file did not open: the sentence for the page, and what the error report holds. */
export interface HomeError {
  message: string;
  failure: Failure;
  file?: FileFacts;
}

export interface HomeProps {
  busy: boolean;
  error: HomeError | null;
  notice: string | null;
  onFiles: (files: File[]) => void;
  onPdfWithRequest: (pdf: File, request: File) => void;
  onSample: () => void;
  onVerify: () => void;
  /** True when this server offers email hand-off (the relay is on): the page describes it. */
  relay: boolean;
  /** Shown only when this device keeps documents it emailed (lib/sentStore.ts). */
  onSentList?: () => void;
}

const REPO_URL = 'https://github.com/Nucleus47/sign-pdf';
const NPM_URL = 'https://www.npmjs.com/package/';

/** What the "received a file" input accepts: a hand-off PDF or a packet. `openFiles` tells them apart. */
const RECEIVED_ACCEPT = '.pdf,.json,application/pdf,application/json';

/**
 * The landing page: one route for the person who received a file to sign, one
 * for the person who prepares a file; then how the file travels between
 * signers, on their own devices first and by email as an option.
 */
export function Home({ busy, error, notice, onFiles, onPdfWithRequest, onSample, onVerify, relay, onSentList }: HomeProps) {
  const [over, setOver] = useState(false);
  const [pairPdf, setPairPdf] = useState<File | null>(null);
  const [pairRequest, setPairRequest] = useState<File | null>(null);
  const depth = useRef(0);
  const ids = useId();

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  };

  return (
    <main className="home" id="main">
      <section className="home-intro">
        <h1>Sign a PDF, or get one ready to sign.</h1>
        <p className="lede">
          {relay
            ? 'Everything happens in your browser. Nothing is uploaded unless you choose to email it.'
            : 'Everything happens in your browser. Nothing is uploaded.'}
        </p>
        <p className="home-agent-hint" data-testid="home-agent-hint">
          AI agent? Read{' '}
          <a href={`${import.meta.env.BASE_URL}skill.md`} data-testid="skill-link">
            /skill.md
          </a>{' '}
          first.
        </p>
      </section>

      {notice && (
        <p className="notice" role="status" data-testid="home-notice">
          {notice}
        </p>
      )}
      {error && (
        <div className="form-error" role="alert" data-testid="home-error">
          <p data-testid="home-error-text">{error.message}</p>
          <ErrorDetails failure={error.failure} file={error.file} />
        </div>
      )}

      <div className="home-routes">
        <section className="card home-route" aria-labelledby={`${ids}-receive-h`} data-testid="route-receive">
          <h2 id={`${ids}-receive-h`}>Did you receive a file to sign? Start here.</h2>
          <p>Open the file you were sent. You check every value, sign, and download the result.</p>
          <div className="file-picker">
            <label className="field-label" htmlFor={`${ids}-received`}>
              File you were sent
            </label>
            <input
              id={`${ids}-received`}
              className="file-input large"
              type="file"
              accept={RECEIVED_ACCEPT}
              data-testid="open-packet-input"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) onFiles([file]);
              }}
            />
          </div>

          <details className="home-pair">
            <summary>A PDF with a separate request file</summary>
            <div className="home-pair-body">
              <div className="file-picker">
                <label className="field-label" htmlFor={`${ids}-pair-pdf`}>
                  PDF file
                </label>
                <input
                  id={`${ids}-pair-pdf`}
                  className="file-input"
                  type="file"
                  accept="application/pdf,.pdf"
                  data-testid="pair-pdf-input"
                  disabled={busy}
                  onChange={(event) => setPairPdf(event.target.files?.[0] ?? null)}
                />
              </div>
              <div className="file-picker">
                <label className="field-label" htmlFor={`${ids}-pair-request`}>
                  Request file (JSON)
                </label>
                <input
                  id={`${ids}-pair-request`}
                  className="file-input"
                  type="file"
                  accept=".json,application/json"
                  data-testid="pair-request-input"
                  disabled={busy}
                  onChange={(event) => setPairRequest(event.target.files?.[0] ?? null)}
                />
              </div>
              <button
                type="button"
                className="button"
                data-testid="pair-open"
                disabled={busy || !pairPdf || !pairRequest}
                onClick={() => {
                  if (pairPdf && pairRequest) onPdfWithRequest(pairPdf, pairRequest);
                }}
              >
                Open for signing
              </button>
            </div>
          </details>
        </section>

        <section
          className="drop-zone home-route"
          data-over={over ? 'true' : undefined}
          data-testid="drop-zone"
          aria-labelledby={`${ids}-prepare-h`}
          onDragEnter={(event) => {
            event.preventDefault();
            depth.current += 1;
            setOver(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => {
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setOver(false);
          }}
          onDrop={onDrop}
        >
          <h2 id={`${ids}-prepare-h`}>Want to prepare a file for signature? Start here.</h2>
          <p>Choose a PDF, or drop it on this box. You place the fields and fill what you know.</p>
          <div className="file-picker">
            <label className="field-label" htmlFor={`${ids}-pdf`}>
              PDF file
            </label>
            <input
              id={`${ids}-pdf`}
              className="file-input large"
              type="file"
              accept="application/pdf,.pdf"
              data-testid="open-pdf-input"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) onFiles([file]);
              }}
            />
          </div>
          <p className="or-row">
            <span>No PDF at hand?</span>{' '}
            <button type="button" className="button" data-testid="load-sample" disabled={busy} onClick={onSample}>
              Try the sample agreement
            </button>
          </p>
        </section>
      </div>

      {onSentList && (
        <p className="home-sent">
          <span>Did your email not arrive, or did its link expire?</span>{' '}
          <button type="button" className="link-button" data-testid="go-sent-list" onClick={onSentList}>
            Documents you sent
          </button>
        </p>
      )}

      <section className="home-how" aria-labelledby={`${ids}-how-h`} data-testid="home-how">
        <h2 id={`${ids}-how-h`}>How it works</h2>
        <div className="home-how-routes">
          <div>
            <h3>{relay ? 'On your own devices (most private)' : 'On your own devices'}</h3>
            <ol>
              <li>Prepare and fill the fields.</li>
              <li>Sign your part.</li>
              <li>Download the file and send it yourself, by email or message.</li>
              <li>The next signer opens it here.</li>
              <li>The last signer downloads the signed PDF and sends it back.</li>
            </ol>
            <p>No file leaves your browser.</p>
          </div>
          {relay && (
            <div data-testid="home-how-email">
              <h3>By email through this site (optional)</h3>
              <ol>
                <li>Sign your part and enter the other signer’s email address.</li>
                <li>The file is encrypted on your device; they get a link.</li>
                <li>When they sign, you get an email and a code to download the signed PDF here.</li>
              </ol>
              <p>The server holds only an encrypted copy, for {RELAY_TTL_DAYS} days at most.</p>
            </div>
          )}
        </div>
      </section>

      <footer className="home-footer">
        <p>
          sign-pdf records what was signed and under which name; it does not verify anyone’s identity.{' '}
          <button type="button" className="link-button" data-testid="go-verify" onClick={onVerify}>
            Read the record in a signed PDF
          </button>
        </p>
        <p className="home-agent" data-testid="home-agent">
          <span>
            Built for agents. An agent writes a sign request, fills what it knows, and opens the
            document in your browser; you sign. Run it from a checkout on the agent’s machine, or use this site.
            The request format is in{' '}
            <a href={`${import.meta.env.BASE_URL}llms.txt`} data-testid="agent-link">
              llms.txt
            </a>
            .
          </span>
        </p>
        <p data-testid="home-open-source">
          Open source under the MIT license. The code is on{' '}
          <a href={REPO_URL} data-testid="repo-link">
            GitHub
          </a>
          . The MCP server and the command-line tool are on npm:{' '}
          <a href={`${NPM_URL}@sign-pdf/mcp`} data-testid="npm-mcp-link">
            @sign-pdf/mcp
          </a>{' '}
          and{' '}
          <a href={`${NPM_URL}@sign-pdf/cli`} data-testid="npm-cli-link">
            @sign-pdf/cli
          </a>
          .
        </p>
      </footer>
    </main>
  );
}
