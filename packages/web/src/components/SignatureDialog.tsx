/**
 * Signature and initials capture: draw, type or upload.
 * The result is handed to the caller as PNG bytes and kept in memory only.
 */
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import type { SignatureMethod } from '@sign-pdf/spec';
import {
  drawStrokes,
  imageFileToPng,
  isAcceptedUpload,
  loadSignatureFont,
  SIGNATURE_FONT,
  strokesToPng,
  typedToPng,
  type Stroke,
} from '../lib/signatureImage.ts';
import { Dialog } from './Dialog.tsx';

export interface SignatureResult {
  png: Uint8Array;
  method: SignatureMethod;
}

export interface SignatureDialogProps {
  kind: 'signature' | 'initials';
  /** Name of the field being signed, shown in the title. */
  fieldName: string;
  /** Starting text for the Type tab: the signer's name or initials. */
  suggestedText: string;
  /** A signature of the same kind made earlier in this session, offered for reuse. */
  reusePreviewUrl?: string;
  onReuse?: () => void;
  onDone: (result: SignatureResult) => void;
  onClose: () => void;
}

type Mode = 'draw' | 'type' | 'upload';
const MODES: readonly { id: Mode; label: string }[] = [
  { id: 'draw', label: 'Draw' },
  { id: 'type', label: 'Type' },
  { id: 'upload', label: 'Upload' },
];

export function SignatureDialog({
  kind,
  fieldName,
  suggestedText,
  reusePreviewUrl,
  onReuse,
  onDone,
  onClose,
}: SignatureDialogProps) {
  const noun = kind === 'initials' ? 'initials' : 'signature';
  const [mode, setMode] = useState<Mode>('draw');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [typed, setTyped] = useState(suggestedText);
  const [upload, setUpload] = useState<{ file: File; url: string } | null>(null);
  const [removePaper, setRemovePaper] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const padSize = useRef({ width: 0, height: 0 });
  const tabsId = useId();

  useEffect(() => {
    void loadSignatureFont();
  }, []);

  useEffect(
    () => () => {
      if (upload) URL.revokeObjectURL(upload.url);
    },
    [upload],
  );

  // Decode a chosen file before previewing it. A file that is not really an image gets its
  // message at once, and no broken <img> is shown (Chromium reports a failed blob: image
  // as a connect-src violation).
  const latestChoice = useRef(0);
  const chooseUpload = async (file: File) => {
    latestChoice.current += 1;
    const choice = latestChoice.current;
    setError(null);
    let readable = true;
    try {
      (await createImageBitmap(file)).close();
    } catch {
      readable = false;
    }
    if (choice !== latestChoice.current) return;
    if (!readable) {
      setUpload(null);
      setError('That image could not be read. Choose a PNG or JPEG file.');
      return;
    }
    setUpload({ file, url: URL.createObjectURL(file) });
  };

  const ready =
    mode === 'draw' ? strokes.length > 0 : mode === 'type' ? typed.trim() !== '' : upload !== null;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      let png: Uint8Array | null = null;
      let method: SignatureMethod = 'drawn';
      if (mode === 'draw') {
        png = await strokesToPng(strokes, padSize.current.width, padSize.current.height);
      } else if (mode === 'type') {
        method = 'typed';
        png = await typedToPng(typed);
      } else if (upload) {
        method = 'uploaded';
        png = await imageFileToPng(upload.file, { removePaper });
      }
      if (!png) {
        setError(`There is no ${noun} to use yet.`);
        return;
      }
      onDone({ png, method });
    } catch {
      setError(
        mode === 'upload'
          ? 'That image could not be read. Choose a PNG or JPEG file.'
          : `The ${noun} could not be saved. Try again.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const selectMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  return (
    <Dialog
      title={kind === 'initials' ? `Add your initials: ${fieldName}` : `Add your signature: ${fieldName}`}
      onClose={onClose}
      testId="signature-dialog"
      wide
      footer={
        <>
          <button type="button" className="button" data-testid="signature-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            data-testid="signature-apply"
            disabled={!ready || busy}
            onClick={() => void apply()}
          >
            Use this {noun}
          </button>
        </>
      }
    >
      {reusePreviewUrl && onReuse && (
        <div className="reuse-offer">
          <img src={reusePreviewUrl} alt={`The ${noun} you made earlier in this session`} />
          <button type="button" className="button" data-testid="signature-reuse" onClick={onReuse}>
            Use the same {noun}
          </button>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label={`How to add your ${noun}`}>
        {MODES.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${tabsId}-tab-${item.id}`}
            aria-selected={mode === item.id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={mode === item.id ? 0 : -1}
            className="tab"
            data-testid={`signature-tab-${item.id}`}
            data-autofocus={item.id === 'draw' ? '' : undefined}
            onClick={() => selectMode(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const step = event.key === 'ArrowRight' ? 1 : -1;
              const next = MODES[(index + step + MODES.length) % MODES.length];
              if (!next) return;
              selectMode(next.id);
              document.getElementById(`${tabsId}-tab-${next.id}`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-tab-${mode}`}
        className="tab-panel"
      >
        {mode === 'draw' && (
          <DrawPad
            noun={noun}
            strokes={strokes}
            onStrokes={setStrokes}
            onSize={(size) => {
              padSize.current = size;
            }}
          />
        )}

        {mode === 'type' && (
          <div className="type-pane">
            <label className="field-label" htmlFor={`${tabsId}-typed`}>
              {kind === 'initials' ? 'Your initials' : 'Your name'}
            </label>
            <input
              id={`${tabsId}-typed`}
              className="input"
              type="text"
              autoComplete="off"
              maxLength={80}
              data-testid="signature-typed-input"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <p
              className="typed-preview"
              data-testid="signature-typed-preview"
              style={{ fontFamily: `"${SIGNATURE_FONT}", cursive` }}
              aria-label={`Preview of your typed ${noun}`}
            >
              {typed.trim() || ' '}
            </p>
          </div>
        )}

        {mode === 'upload' && (
          <div className="upload-pane">
            <label className="field-label" htmlFor={`${tabsId}-upload`}>
              Image of your {noun} (PNG or JPEG)
            </label>
            <input
              id={`${tabsId}-upload`}
              className="file-input"
              type="file"
              accept="image/png,image/jpeg"
              data-testid="signature-upload-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (!isAcceptedUpload(file)) {
                  latestChoice.current += 1;
                  setUpload(null);
                  setError('Choose a PNG or JPEG image.');
                  return;
                }
                void chooseUpload(file);
              }}
            />
            <label className="check-row">
              <input
                type="checkbox"
                data-testid="signature-remove-paper"
                checked={removePaper}
                onChange={(event) => setRemovePaper(event.target.checked)}
              />
              <span>Remove the white paper around it</span>
            </label>
            {upload && <img className="upload-preview" src={upload.url} alt={`The ${noun} image you chose`} />}
          </div>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert" data-testid="signature-error">
          {error}
        </p>
      )}
      <p className="hint">
        Your {noun} is used for this document only. It is not saved in this browser or sent anywhere.
      </p>
    </Dialog>
  );
}

interface DrawPadProps {
  noun: string;
  strokes: Stroke[];
  onStrokes: (update: (previous: Stroke[]) => Stroke[]) => void;
  onSize: (size: { width: number; height: number }) => void;
}

function DrawPad({ noun, strokes, onStrokes, onSize }: DrawPadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const active = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Track the pad's CSS size; the backing store follows the device pixel ratio.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const next = { width: canvas.clientWidth, height: canvas.clientHeight };
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
      onSize(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSize only writes a ref
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    drawStrokes(context, strokes, 2.4);
  }, [strokes, size]);

  const pointOf = (event: { clientX: number; clientY: number }) => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (active.current !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    active.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = pointOf(event);
    onStrokes((previous) => [...previous, [point]]);
  };

  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (active.current !== event.pointerId) return;
    // Coalesced events give the full path of a fast stylus or finger stroke.
    const native = event.nativeEvent;
    const samples =
      typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
        ? native.getCoalescedEvents()
        : [native];
    const points = samples.map(pointOf);
    onStrokes((previous) => {
      const last = previous.at(-1);
      if (!last) return previous;
      return [...previous.slice(0, -1), [...last, ...points]];
    });
  };

  const up = (event: PointerEvent<HTMLCanvasElement>) => {
    if (active.current !== event.pointerId) return;
    active.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div className="draw-pane">
      <div className="draw-pad">
        <canvas
          ref={canvasRef}
          className="draw-canvas"
          data-testid="signature-pad"
          role="img"
          aria-label={
            strokes.length > 0
              ? `Your drawn ${noun}`
              : `Drawing area for your ${noun}. Drawing needs a mouse, finger or pen; with a keyboard, use the Type tab.`
          }
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        <span className="draw-baseline" aria-hidden="true" />
        {strokes.length === 0 && (
          <span className="draw-placeholder" aria-hidden="true">
            Draw your {noun} here
          </span>
        )}
      </div>
      <div className="draw-actions">
        <button
          type="button"
          className="button quiet"
          data-testid="signature-undo"
          disabled={strokes.length === 0}
          onClick={() => onStrokes((previous) => previous.slice(0, -1))}
        >
          Undo stroke
        </button>
        <button
          type="button"
          className="button quiet"
          data-testid="signature-clear"
          disabled={strokes.length === 0}
          onClick={() => onStrokes(() => [])}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
