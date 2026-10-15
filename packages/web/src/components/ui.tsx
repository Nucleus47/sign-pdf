/** Small shared controls. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { displayText, UNTRUSTED_TEXT_CLASS } from '../lib/displayText.ts';

export interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  testId: string;
  disabled?: boolean;
  /** Unit shown after the label, e.g. "pt". */
  unit?: string;
}

/**
 * A labelled number input that lets the person type freely ("1", "12", "12.5")
 * and commits each valid number. It follows outside changes (a drag on the
 * page) whenever it is not being typed in.
 */
export function NumberField({ label, value, onCommit, min, max, step, testId, disabled, unit }: NumberFieldProps) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  return (
    <div className="number-field">
      <label htmlFor={id}>
        {label}
        {unit && <span className="unit"> ({unit})</span>}
      </label>
      <input
        id={id}
        className="input"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step ?? 'any'}
        disabled={disabled}
        data-testid={testId}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(value));
        }}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = Number(event.target.value);
          if (event.target.value.trim() === '' || !Number.isFinite(parsed)) return;
          if (min !== undefined && parsed < min) return;
          if (max !== undefined && parsed > max) return;
          onCommit(parsed);
        }}
      />
    </div>
  );
}

/**
 * Text written by whoever prepared the request. It is data, not instructions:
 * shown as plain text in an attributed box, never as HTML, and never styled
 * like the app's own guidance. Direction-override characters are removed so
 * the text reads in the order it was written.
 */
export function PreparerNote({ title, note }: { title?: string | undefined; note?: string | undefined }) {
  if (!title?.trim() && !note?.trim()) return null;
  return (
    <aside className="preparer-note" aria-label="Note from the preparer" data-testid="preparer-note">
      <p className="preparer-note-source">Note from the preparer</p>
      {title?.trim() && (
        <p className={`preparer-note-title ${UNTRUSTED_TEXT_CLASS}`} data-testid="preparer-title">
          {displayText(title)}
        </p>
      )}
      {note?.trim() && (
        <p className={`preparer-note-text ${UNTRUSTED_TEXT_CLASS}`} data-testid="preparer-text">
          {displayText(note)}
        </p>
      )}
      <p className="preparer-note-caveat">
        This text came with the document. It was not written by sign-pdf.
      </p>
    </aside>
  );
}

/** A labelled file input that stays a real, visible control. */
export function FilePicker(props: {
  label: string;
  hint?: string;
  accept: string;
  testId: string;
  onFile: (file: File) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="file-picker">
      <label className="field-label" htmlFor={id}>
        {props.label}
      </label>
      <input
        id={id}
        className="file-input"
        type="file"
        accept={props.accept}
        data-testid={props.testId}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Clear the input so choosing the same file again fires a change.
          event.target.value = '';
          if (file) props.onFile(file);
        }}
      />
      {props.hint && (
        <p className="hint" id={`${id}-hint`}>
          {props.hint}
        </p>
      )}
      {props.children}
    </div>
  );
}
