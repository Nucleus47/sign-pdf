import { useId, useRef, useState, type DragEvent } from 'react';
import { core, explainProblem, toCoreProblem, type VerifyResult } from '../lib/core.ts';
import { tooLargeMessage } from '../app/open.ts';
import { ErrorDetails } from '../components/ErrorDetails.tsx';
import { fileFacts, type Failure, type FileFacts } from '../lib/errorReport.ts';
import { looksLikePdf, readBytes } from '../lib/files.ts';
import { displayText, UNTRUSTED_TEXT_CLASS } from '../lib/displayText.ts';
import { AuditView } from './Signed.tsx';

type State =
  | { name: 'idle' }
  | { name: 'reading'; fileName: string }
  | { name: 'done'; fileName: string; result: VerifyResult }
  | { name: 'error'; message: string; failure: Failure; file: FileFacts };

export function Verify() {
  const ids = useId();
  const [state, setState] = useState<State>({ name: 'idle' });
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const check = async (file: File) => {
    setState({ name: 'reading', fileName: file.name });
    const facts = fileFacts(file.name, file.size);
    try {
      const tooLarge = await tooLargeMessage(file);
      if (tooLarge) {
        setState({ name: 'error', message: tooLarge, failure: { code: 'file-too-large', message: 'file-too-large' }, file: facts });
        return;
      }
      const bytes = await readBytes(file);
      if (!looksLikePdf(bytes)) {
        setState({
          name: 'error',
          message: `“${file.name}” is not a PDF. Choose a signed PDF.`,
          failure: { code: 'not-a-pdf', message: 'not-a-pdf' },
          file: facts,
        });
        return;
      }
      setState({ name: 'done', fileName: file.name, result: await core.verifySignedPdf(bytes) });
    } catch (error) {
      const problem = toCoreProblem(error);
      setState({
        name: 'error',
        message: problem.code === 'unknown' ? `${explainProblem(problem)} (${problem.message})` : explainProblem(problem),
        failure: problem,
        file: facts,
      });
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file) void check(file);
  };

  return (
    <main className="home" id="main" data-view="verify">
      <section className="home-intro">
        <h1>Read the record in a signed PDF</h1>
        <p className="lede">
          Open a PDF that was signed with sign-pdf to read the record inside it. The file is read in
          this browser and is not uploaded.
        </p>
      </section>

      <section
        className="drop-zone"
        data-over={over ? 'true' : undefined}
        data-testid="verify-drop-zone"
        aria-labelledby={`${ids}-h`}
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
        <h2 id={`${ids}-h`}>Signed PDF</h2>
        <p>Choose the file, or drop it in this box.</p>
        <div className="file-picker">
          <label className="field-label" htmlFor={`${ids}-file`}>
            Signed PDF file
          </label>
          <input
            id={`${ids}-file`}
            className="file-input large"
            type="file"
            accept="application/pdf,.pdf"
            data-testid="verify-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void check(file);
            }}
          />
        </div>
      </section>

      <div aria-live="polite">
        {state.name === 'reading' && <p role="status">Reading {displayText(state.fileName)}…</p>}
        {state.name === 'error' && (
          <div className="form-error" role="alert" data-testid="verify-error">
            <p>{state.message}</p>
            <ErrorDetails failure={state.failure} file={state.file} />
          </div>
        )}
        {state.name === 'done' && (
          <section className="card verify-result" data-testid="verify-result" data-has-record={state.result.hasAuditRecord ? 'true' : 'false'}
            data-integrity={state.result.integrity}>
            <h2 className={UNTRUSTED_TEXT_CLASS}>{displayText(state.fileName)}</h2>
            {state.result.handoff && (
              <div className="notice warning" data-testid="verify-handoff">
                <p>
                  This is a hand-off PDF between signers. It is not final until every signer has signed.
                </p>
                <p data-testid="verify-handoff-signed">
                  Signed so far, as the file states:{' '}
                  <span className={UNTRUSTED_TEXT_CLASS}>
                    {state.result.handoff.signed.map((signer) => displayText(signer.name).trim() || signer.id).join(', ')}
                  </span>
                </p>
                <p data-testid="verify-handoff-pending">
                  Still to sign:{' '}
                  <span className={UNTRUSTED_TEXT_CLASS}>
                    {state.result.handoff.pending.map((signer) => displayText(signer.name ?? '').trim() || signer.id).join(', ')}
                  </span>
                </p>
              </div>
            )}
            {state.result.hasAuditRecord && state.result.audit ? (
              <div className="notice" data-testid="verify-found">
                <p>This PDF carries a sign-pdf audit record. It is shown below.</p>
                <p data-testid="verify-caveat">
                  The record is a claim stored inside the file. It is not protected against
                  tampering: someone who edits the file can also edit the record. Treat it as
                  information, not as proof.
                </p>
              </div>
            ) : (
              <p className="notice warning" data-testid="verify-not-found">
                No sign-pdf audit record found in this PDF.
              </p>
            )}
            {state.result.problems.length > 0 && (
              <ul className="issues" data-testid="verify-problems">
                {state.result.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            <h3>Fingerprint of this file (SHA-256)</h3>
            <code className="hash" data-testid="verify-sha256">
              {state.result.sha256}
            </code>
            {state.result.audit && <AuditView audit={state.result.audit} />}
          </section>
        )}
      </div>
    </main>
  );
}
