/**
 * "Technical details" under an error: a report the person can copy and send
 * to whoever helps them. It is built on this device and sent nowhere. What it
 * holds, and what it never holds, is in lib/errorReport.ts.
 */
import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { copyText } from '../lib/clipboard.ts';
import { buildErrorReport, formatErrorReport, type Failure, type FileFacts } from '../lib/errorReport.ts';
import { lastUncaught, subscribeUncaught } from '../lib/lastError.ts';
import { reportContext } from '../lib/reportContext.ts';

export interface ErrorDetailsProps {
  failure: Failure;
  /** The extension and size of the file in use, when there is one. Never its name. */
  file?: FileFacts | undefined;
}

type CopyStatus = 'idle' | 'copied' | 'select';

const STATUS_TEXT: Record<CopyStatus, string> = {
  idle: '',
  copied: 'The details are copied.',
  select: 'Select the text, then copy it.',
};

export function ErrorDetails({ failure, file }: ErrorDetailsProps) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CopyStatus>('idle');
  // When the error happened, not when the details were opened.
  const [at] = useState(() => new Date());
  const field = useRef<HTMLTextAreaElement>(null);
  const uncaught = useSyncExternalStore(subscribeUncaught, lastUncaught, lastUncaught);

  // The report reads the page's current view, so it is built only once it is shown.
  let text = '';
  if (open) {
    try {
      text = formatErrorReport(buildErrorReport(failure, reportContext(file, uncaught, at)));
    } catch {
      // The report must never break the error screen it is on (or the error boundary).
      text = `sign-pdf error report\ncode: ${/^[a-z0-9-]{1,64}$/i.test(failure.code) ? failure.code : 'unknown'}\n(the rest of the report could not be made)\n`;
    }
  }

  const copy = async () => {
    setStatus((await copyText(text, field.current)) ? 'copied' : 'select');
  };

  return (
    <details
      className="error-details"
      data-testid="error-details"
      onToggle={(event) => {
        const nowOpen = event.currentTarget.open;
        setOpen(nowOpen);
        if (!nowOpen) setStatus('idle');
      }}
    >
      <summary id={`${ids}-summary`}>Technical details</summary>
      {open && (
        <div className="error-details-body">
          <p className="hint" id={`${ids}-about`}>
            Send these details to the person who helps you. They do not include the document or the
            values in it. Read them before you send them.
          </p>
          <textarea
            ref={field}
            aria-labelledby={`${ids}-summary`}
            className="input error-details-text"
            data-testid="error-details-text"
            aria-describedby={`${ids}-about`}
            readOnly
            spellCheck={false}
            rows={8}
            value={text}
          />
          <button type="button" className="button error-details-copy" data-testid="error-details-copy" onClick={() => void copy()}>
            Copy details
          </button>
          <p className="hint" role="status" data-testid="error-details-status">
            {STATUS_TEXT[status]}
          </p>
        </div>
      )}
    </details>
  );
}
