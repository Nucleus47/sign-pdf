/**
 * The visual field editor for one page: absolutely positioned boxes that can
 * be dragged, resized and driven from the keyboard.
 *
 * This component is the whole interface between the app and "a visual editor":
 * it takes a page, fields and the selected id, and reports rectangle changes.
 * A different drag-and-resize implementation can replace it without touching
 * the views.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { FieldType, PageInfo, Rect } from '@sign-pdf/spec';
import type { Mark } from '../lib/candidates.ts';
import { FIELD_TYPE_LABEL, describeRect } from '../lib/fields.ts';
import {
  clientToPagePoint,
  growRect,
  keyToAction,
  moveRect,
  rectToPx,
  resizeRect,
  type PagePoint,
  type ResizeHandle,
} from '../lib/geometry.ts';

export type FieldTone = 'neutral' | 'todo' | 'done' | 'prefilled' | 'other';

export interface CanvasField {
  id: string;
  type: FieldType;
  /** Label or id, shown in the box and read to assistive technology. */
  name: string;
  rect: Rect;
  /** A locked field can be selected but not moved (it follows an existing form field). */
  locked?: boolean;
  /** Why a locked field cannot move, read to assistive technology. Default: it follows a form field. */
  lockedReason?: string;
  tone?: FieldTone;
  /** Short flag text on the box edge, such as "Sign here". */
  flag?: string;
  /** The field has what it needs: drawn with a check mark and read as "done". */
  done?: boolean;
}

export interface FieldCanvasProps {
  page: PageInfo;
  /** CSS pixels per PDF point. */
  scale: number;
  /** All fields; the canvas draws those on its page. */
  fields: readonly CanvasField[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeRect: (id: string, rect: Rect) => void;
  onDelete?: (id: string) => void;
  /** Enter or Space on a focused box. */
  onActivate?: (id: string) => void;
  /** When set, the next click on the page places a field of this type. */
  placingType?: FieldType | null;
  onPlace?: (point: PagePoint) => void;
  /** What to draw inside a box (a value preview). Defaults to the field name. */
  renderContent?: (field: CanvasField) => ReactNode;
  /** id of the element that explains the keyboard commands. */
  helpId?: string;
  /** A field being placed from the keyboard, drawn but not yet added. */
  ghost?: { type: FieldType; rect: Rect } | null;
  /** Numbered places to draw. The view lists them as buttons too, so these are hidden from assistive technology. */
  marks?: readonly Mark[];
  /** The place the placement box is at, drawn as active. */
  activeMark?: Mark | null;
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  rect: Rect;
  handle: ResizeHandle | null;
}

const HANDLES: readonly ResizeHandle[] = ['nw', 'ne', 'sw', 'se'];

export function FieldCanvas(props: FieldCanvasProps) {
  const { page, scale, fields, selectedId, placingType, onPlace, ghost, marks, activeMark } = props;
  const onPage = fields.filter((field) => field.rect.page === page.page);
  const placing = Boolean(placingType && onPlace);

  return (
    <div
      className="field-canvas"
      data-placing={placing ? 'true' : undefined}
      data-testid={`field-canvas-${page.page}`}
      onClick={(event) => {
        if (!placing || event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        onPlace?.(clientToPagePoint(event.clientX, event.clientY, box, page.page, scale));
      }}
    >
      {marks
        ?.filter((mark) => mark.page === page.page)
        .map((mark) => (
          <PlaceMark
            key={mark.number}
            mark={mark}
            scale={scale}
            active={activeMark?.page === mark.page && activeMark.number === mark.number}
          />
        ))}
      {onPage.map((field) => (
        <FieldBox key={field.id} {...props} field={field} selected={field.id === selectedId} />
      ))}
      {ghost && ghost.rect.page === page.page && (
        <GhostBox
          type={ghost.type}
          rect={ghost.rect}
          scale={scale}
          place={activeMark?.page === page.page ? activeMark.number : undefined}
        />
      )}
    </div>
  );
}

interface FieldBoxProps extends FieldCanvasProps {
  field: CanvasField;
  selected: boolean;
}

function FieldBox({
  field,
  selected,
  page,
  scale,
  onSelect,
  onChangeRect,
  onDelete,
  onActivate,
  renderContent,
  helpId,
}: FieldBoxProps) {
  const drag = useRef<Drag | null>(null);
  const box = rectToPx(field.rect, scale);
  const movable = !field.locked;

  const begin = (event: PointerEvent<HTMLElement>, handle: ResizeHandle | null) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.stopPropagation();
    onSelect(field.id);
    if (!movable) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: field.rect,
      handle,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = (event.clientX - current.startX) / scale;
    const dy = (event.clientY - current.startY) / scale;
    // A press that barely moves is a click, not a drag.
    if (Math.abs(dx * scale) < 2 && Math.abs(dy * scale) < 2) return;
    onChangeRect(
      field.id,
      current.handle
        ? resizeRect(current.rect, current.handle, dx, dy, page)
        : moveRect(current.rect, dx, dy, page),
    );
  };

  const end = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(field.id);
      onActivate?.(field.id);
      return;
    }
    if (event.key === 'Escape') {
      onSelect(null);
      return;
    }
    const action = keyToAction(event);
    if (!action) return;
    if (action.kind === 'delete') {
      if (!onDelete) return;
      event.preventDefault();
      onDelete(field.id);
      return;
    }
    event.preventDefault();
    if (!movable) return;
    onChangeRect(
      field.id,
      action.kind === 'move'
        ? moveRect(field.rect, action.dx, action.dy, page)
        : growRect(field.rect, action.dw, action.dh, page),
    );
  };

  return (
    <div
      className="field-box"
      role="button"
      aria-roledescription="field on the page"
      tabIndex={0}
      aria-label={`${FIELD_TYPE_LABEL[field.type]} field ${field.name}: ${describeRect(field.rect)}${
        field.locked ? `; ${field.lockedReason ?? 'position fixed by the form field'}` : ''
      }${field.done ? '; done' : ''}`}
      aria-describedby={helpId}
      aria-current={selected ? 'true' : undefined}
      data-testid={`field-box-${field.id}`}
      data-field-box={field.id}
      data-type={field.type}
      data-tone={field.tone ?? 'neutral'}
      data-selected={selected ? 'true' : undefined}
      data-locked={field.locked ? 'true' : undefined}
      data-done={field.done ? 'true' : undefined}
      data-x={field.rect.x}
      data-y={field.rect.y}
      data-width={field.rect.width}
      data-height={field.rect.height}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={(event) => begin(event, null)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onFocus={() => onSelect(field.id)}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onActivate?.(field.id)}
    >
      {field.flag && (
        <span className="field-flag" aria-hidden="true">
          {field.flag}
        </span>
      )}
      <span className="field-content">{renderContent ? renderContent(field) : field.name}</span>
      {field.done && <CheckMark className="field-done" testId={`field-done-${field.id}`} />}
      {selected &&
        movable &&
        HANDLES.map((handle) => (
          <span
            key={handle}
            className={`field-handle handle-${handle}`}
            data-testid={`field-handle-${field.id}-${handle}`}
            aria-hidden="true"
            onPointerDown={(event) => begin(event, handle)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        ))}
    </div>
  );
}

/**
 * The placement box. The status line announces it, so it is hidden from
 * assistive technology; `data-ghost` lets the view scroll it into view.
 * On a numbered place its tag shows that number, because the place's own
 * badge is hidden: the tag would cover it on a narrow place.
 */
function GhostBox({ type, rect, scale, place }: { type: FieldType; rect: Rect; scale: number; place?: number }) {
  const box = rectToPx(rect, scale);
  return (
    <div
      className="field-ghost"
      aria-hidden="true"
      data-ghost="true"
      data-testid="field-ghost"
      data-type={type}
      data-x={rect.x}
      data-y={rect.y}
      data-width={rect.width}
      data-height={rect.height}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <span className="field-ghost-tag">
        {place !== undefined && (
          <span className="field-ghost-place" data-testid="field-ghost-place">
            {place}
          </span>
        )}
        {FIELD_TYPE_LABEL[type]} <kbd>Enter</kbd>
      </span>
    </div>
  );
}

/** Badge size in CSS pixels at 1:1 zoom, and its limits. */
const MARK_SIZE_PT = 14;
const MARK_SIZE_PX = { min: 14, max: 20 };

/**
 * A numbered place: a dotted outline where the field would go and a number
 * badge on its top-right corner, never over the printed label.
 */
function PlaceMark({ mark, scale, active }: { mark: Mark; scale: number; active: boolean }) {
  const box = rectToPx(mark.target, scale);
  return (
    <div
      className="place-mark"
      aria-hidden="true"
      data-testid={`place-mark-${mark.page}-${mark.number}`}
      data-active={active ? 'true' : undefined}
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        ['--mark-size' as string]: `${Math.round(Math.min(MARK_SIZE_PX.max, Math.max(MARK_SIZE_PX.min, MARK_SIZE_PT * scale)))}px`,
      }}
    >
      <span className="place-mark-badge">{mark.number}</span>
    </div>
  );
}

/**
 * The green check of a done field. Decorative: the field's name or row says
 * "done" in words, so the mark is never the only signal.
 */
export function CheckMark({ className, testId }: { className: string; testId?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-testid={testId}>
      <circle cx="8" cy="8" r="8" />
      <path d="M4.4 8.3 6.9 10.7 11.6 5.6" fill="none" />
    </svg>
  );
}

/** The keyboard help every field box points to. Render it once per view. */
export function FieldKeyboardHelp({ id, canDelete }: { id: string; canDelete: boolean }) {
  return (
    <p id={id} className="visually-hidden">
      Arrow keys move the field by 1 point, with Shift by 10 points. Alt with arrow keys changes its
      size.{canDelete ? ' Delete removes it; removal can be undone.' : ''}
    </p>
  );
}
