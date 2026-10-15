import type { AuditRecord, ResolvedRequest } from '@sign-pdf/spec';
import { ErrorDetails } from '../components/ErrorDetails.tsx';
import { PdfViewer } from '../components/PdfViewer.tsx';
import type { FinalizeResult } from '../lib/core.ts';
import { displayText, UNTRUSTED_TEXT_CLASS } from '../lib/displayText.ts';
import { downloadFile } from '../lib/files.ts';
import { fieldName, signedFileName, summarizeAudit } from '../lib/signing.ts';
import type { PostResult } from '../lib/transport.ts';

export interface SignedProps {
  documentName: string;
  resolved: ResolvedRequest;
  result: FinalizeResult;
  /** Loopback hand-back: null when there is no session. */
  sent: PostResult | 'sending' | null;
  /** Post the same signed PDF to the requesting app again. Present in a session. */
  onSendAgain?: () => void;
  /**
   * An emailed document: the first signer's name (untrusted). The signed PDF
   * goes back to them through the relay, not to a requesting app.
   */
  sentTo?: string;
  onStartOver: () => void;
}

export function Signed({ documentName, resolved, result, sent, onSendAgain, sentTo, onStartOver }: SignedProps) {
  // The name is untrusted: direction overrides must not disguise the file's extension.
  const fileName = signedFileName(displayText(documentName));
  const names = new Map(resolved.fields.map((field) => [field.id, fieldName(field)]));

  return (
    <main className="workspace" id="main" data-view="signed">
      <PdfViewer pdf={result.pdf} label={`Signed document: ${fileName}`} />
      <aside className="panel" aria-label="Signed document">
        <header className="panel-header">
          <h1 data-testid="signed-heading" tabIndex={-1}>
            Signed
          </h1>
        </header>

        {/* The one thing to do next, first and largest. */}
        <button
          type="button"
          className="button primary download-signed"
          data-testid="download-signed"
          onClick={() => downloadFile(fileName, result.pdf, 'application/pdf')}
        >
          <span>Download the signed PDF</span>
          <span className={`download-name ${UNTRUSTED_TEXT_CLASS}`}>{fileName}</span>
        </button>

        {sent === 'sending' && (
          <p className="notice" role="status" data-testid="sent-status">
            {sentTo === undefined ? (
              'Sending the signed PDF back to the requesting app…'
            ) : (
              <>
                Encrypting the signed PDF and sending it back to <span className={UNTRUSTED_TEXT_CLASS}>{sentTo}</span>…
              </>
            )}
          </p>
        )}
        {sent !== null && sent !== 'sending' && sent.ok && (
          <p className="notice success" role="status" data-testid="sent-status">
            {sentTo === undefined ? (
              'Sent back to the requesting app. You can close this tab.'
            ) : (
              <>
                Sent back to <span className={UNTRUSTED_TEXT_CLASS}>{sentTo}</span>. Download your own copy above;
                this page keeps nothing.
              </>
            )}
          </p>
        )}
        {sent !== null && sent !== 'sending' && !sent.ok && (
          <div className="form-error" role="alert" data-testid="sent-error" data-code={sent.code}>
            {sentTo === undefined ? (
              <p>
                The signed PDF could not be sent back to the requesting app. {sent.error}{' '}
                {onSendAgain ? 'Try sending it again, or download' : 'Download'} it below and pass it
                on yourself.
              </p>
            ) : (
              <p>
                The signed PDF was not sent back to <span className={UNTRUSTED_TEXT_CLASS}>{sentTo}</span>. {sent.error}{' '}
                You can still download it above.
              </p>
            )}
            <ErrorDetails
              failure={{
                code: sent.code ?? 'send-failed',
                message: sent.status === undefined ? sent.error : `${sent.error} (HTTP ${sent.status})`,
              }}
              file={{ extension: 'pdf', bytes: result.pdf.length }}
            />
          </div>
        )}

        <div className="button-column">
          {onSendAgain && sent !== null && sent !== 'sending' && !sent.ok && (
            <button type="button" className="button" data-testid="send-again" onClick={onSendAgain}>
              {sentTo === undefined ? 'Try sending again' : 'Try again'}
            </button>
          )}
        </div>

        <section className="panel-section">
          <h2>Fingerprint of the signed file</h2>
          <p className="hint">SHA-256. Anyone holding the file can compute it again to confirm the file is unchanged.</p>
          <code className="hash" data-testid="signed-sha256">
            {result.sha256}
          </code>
        </section>

        <AuditView audit={result.audit} names={names} />

        <div className="button-row secondary">
          <button type="button" className="button quiet" data-testid="start-over" onClick={onStartOver}>
            Open another document
          </button>
        </div>
      </aside>
    </main>
  );
}

function NameList({ title, names, testId }: { title: string; names: string[]; testId: string }) {
  if (names.length === 0) return null;
  return (
    <div className="audit-group" data-testid={testId}>
      <h3>{title}</h3>
      <ul>
        {names.map((name, index) => (
          <li key={`${name}-${index}`} className={UNTRUSTED_TEXT_CLASS}>
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The audit record in words. Shared by the signed screen and the verify view. */
export function AuditView({ audit, names }: { audit: AuditRecord; names?: ReadonlyMap<string, string> }) {
  const summary = summarizeAudit(audit, names);
  return (
    <section className="panel-section audit" data-testid="audit-summary">
      <h2>Record kept inside the PDF</h2>
      <dl className="audit-facts">
        {audit.passes ? (
          <>
            <dt>Signed by, in turn (names as typed, this device’s clock)</dt>
            <dd>
              <ol className="audit-passes" data-testid="audit-passes">
                {audit.passes.map((pass) => (
                  <li key={pass.signerId} data-testid={`audit-pass-${pass.signerId}`}>
                    <span className={UNTRUSTED_TEXT_CLASS}>{displayText(pass.signer.name)}</span>
                    <time dateTime={pass.signedAt}>{new Date(pass.signedAt).toLocaleString()}</time>
                    {pass.fieldIds.length > 0 && (
                      <span className={`audit-pass-fields ${UNTRUSTED_TEXT_CLASS}`}>
                        {pass.fieldIds.map((id) => displayText(names?.get(id) ?? id)).join(', ')}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </dd>
          </>
        ) : (
          <>
            <dt>Signed by (name as typed, this device’s clock)</dt>
            <dd className="audit-pass">
              <span data-testid="audit-signer" className={UNTRUSTED_TEXT_CLASS}>
                {displayText(audit.signer.name)}
              </span>
              <time dateTime={audit.signedAt}>{new Date(audit.signedAt).toLocaleString()}</time>
              {summary.signed.length > 0 && (
                <span data-testid="audit-signed" className={`audit-pass-fields ${UNTRUSTED_TEXT_CLASS}`}>
                  {summary.signed.join(', ')}
                </span>
              )}
            </dd>
          </>
        )}
        <dt>Statement accepted</dt>
        <dd className={UNTRUSTED_TEXT_CLASS}>{displayText(audit.consent.text)}</dd>
      </dl>
      <NameList title="Filled by the human" names={summary.humanFilled} testId="audit-human-filled" />
      <NameList title="Prefilled, then changed by the human" names={summary.humanChanged} testId="audit-human-changed" />
      <NameList title="Suggested by the preparer, kept as suggested" names={summary.humanKept} testId="audit-human-kept" />
      <NameList title="Prefilled by the preparer (agent), left as is" names={summary.agentFilled} testId="audit-agent-filled" />
      <NameList title="Moved or resized by the human" names={summary.humanMoved} testId="audit-moved" />
      <details className="sign-details" data-testid="audit-original">
        <summary>Original document</summary>
        <div className="sign-details-body">
          <span className={UNTRUSTED_TEXT_CLASS} data-testid="audit-document-name">
            {displayText(audit.document.name)}
          </span>
          <code className="hash small">{audit.document.originalSha256}</code>
        </div>
      </details>
      <p className="hint">
        The record states what the signing device reported. It is not tamper-evident and does not
        prove who the signer is.
      </p>
    </section>
  );
}
