/**
 * "Paste a request": the browser agent API for an agent that can only type
 * into a page. The JSON goes through apply_request, the same path as
 * `window.signPdf` and WebMCP; nothing is signed here.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { AgentResult } from '../agent/api.ts';
import { displayText, UNTRUSTED_TEXT_CLASS } from '../lib/displayText.ts';

export const HASH_MISMATCH_TEXT = 'This request was written for a different PDF. Pick the matching file.';

interface Issue {
  code?: string;
  message?: string;
  field_id?: string;
  hint?: string;
}

/** What to tell the person about an apply_request result. */
export function describeApplyResult(result: AgentResult): { ok: boolean; text: string; issues: Issue[] } {
  if (result['applied'] === true) {
    const count = Number(result['field_count'] ?? 0);
    return { ok: true, text: `The request is on the page: ${count} ${count === 1 ? 'field' : 'fields'}. Check each one before you continue.`, issues: [] };
  }
  const validation = result['validation'] as { errors?: Issue[] } | undefined;
  const issues = validation?.errors ?? [];
  if (issues.some((issue) => issue.code === 'hash-mismatch')) return { ok: false, text: HASH_MISMATCH_TEXT, issues: [] };
  if (issues.length > 0) return { ok: false, text: 'The request was not applied. Fix these problems and try again:', issues };
  const error = result['error'] as Issue | undefined;
  return { ok: false, text: `The request was not applied. ${error?.message ?? ''}`.trim(), issues: [] };
}

export interface RequestPasteBoxProps {
  /** The last result, from this box or a #request= link. */
  result: AgentResult | null;
  onApply: (request: unknown) => Promise<void>;
  /** Open at first, when a request is waiting to be shown. */
  open?: boolean;
  /** Given while a link's request waits: forget it. */
  onDismiss?: () => void;
}

export function RequestPasteBox({ result, onApply, open = false, onDismiss }: RequestPasteBoxProps) {
  const ids = useId();
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setParseError(null);
    let request: unknown;
    try {
      request = JSON.parse(text);
    } catch {
      setParseError('This is not valid JSON. Paste the whole request, from { to }.');
      return;
    }
    setBusy(true);
    try {
      await onApply(request);
    } finally {
      setBusy(false);
    }
  };

  const resultRef = useRef<HTMLDivElement>(null);
  // A result from a #request= link appears without a click: bring it into view.
  useEffect(() => {
    resultRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [result, parseError]);

  const shown = parseError ? { ok: false, text: parseError, issues: [] } : result ? describeApplyResult(result) : null;

  return (
    <details className="panel-section request-paste" open={open || undefined} data-testid="request-paste">
      <summary>Paste a request from an agent</summary>
      <div className="request-paste-body">
        <p className="hint">
          An agent can write the fields as a sign request (JSON). Paste it here to put its fields on the page. You can
          check and change every field before anyone signs.
        </p>
        <div className="form-item">
          <label htmlFor={`${ids}-json`}>Request JSON</label>
          <textarea
            id={`${ids}-json`}
            className="input request-json"
            rows={6}
            spellCheck={false}
            autoComplete="off"
            data-testid="request-json"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <button type="button" className="button" data-testid="apply-request" disabled={busy || text.trim() === ''} onClick={() => void apply()}>
          Apply request
        </button>
        {shown && (
          <div className={shown.ok ? 'notice success' : 'form-error'} role={shown.ok ? 'status' : 'alert'} data-testid="request-result" ref={resultRef}>
            <p>{shown.text}</p>
            {shown.issues.length > 0 && (
              <ul className="request-issues" data-testid="request-issues">
                {shown.issues.map((issue, index) => (
                  <li key={index} className={UNTRUSTED_TEXT_CLASS}>
                    {issue.field_id !== undefined && <strong>{displayText(issue.field_id)}: </strong>}
                    {displayText(issue.message ?? '')}
                    {issue.hint !== undefined && <> {displayText(issue.hint)}</>}
                  </li>
                ))}
              </ul>
            )}
            {!shown.ok && onDismiss && (
              <button type="button" className="button" data-testid="dismiss-request" onClick={onDismiss}>
                Forget the request from the link
              </button>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
