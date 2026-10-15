/**
 * In-page modal dialog. The app never uses alert, confirm or prompt.
 * role="dialog", aria-modal, focus moved in and trapped, Escape closes,
 * focus returns to whatever opened it.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons row at the bottom. */
  footer?: ReactNode;
  testId?: string;
  /** Wider layout for the signature pad. */
  wide?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, footer, testId, wide }: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const preferred = panel?.querySelector<HTMLElement>('[data-autofocus]');
    (preferred ?? panel)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (item) => !item.closest('[hidden]'),
    );
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={wide ? 'dialog wide' : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="button quiet icon"
            aria-label="Close"
            data-testid={testId ? `${testId}-close` : 'dialog-close'}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
