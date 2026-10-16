/**
 * Prepare view: a person or a browser agent lays out the fields.
 * Everything that can be done with a pointer can also be done through the
 * form panel, and the form panel is ordinary labelled HTML.
 */
import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { isSigningField, type FieldType, type PageInfo, type Rect, type SignRequestInput } from '@sign-pdf/spec';
import type { AgentResult } from '../agent/api.ts';
import { useAgentApi } from '../agent/expose.ts';
import type { LoadedDocument } from '../app/open.ts';
import { ErrorDetails } from '../components/ErrorDetails.tsx';
import { FieldCanvas, FieldKeyboardHelp, type CanvasField } from '../components/FieldCanvas.tsx';
import { PdfViewer } from '../components/PdfViewer.tsx';
import { RequestPasteBox } from '../components/RequestPasteBox.tsx';
import { ShortcutsDialog } from '../components/ShortcutsDialog.tsx';
import { NumberField } from '../components/ui.tsx';
import { markAt, markLabel, numberMarks, resolveTargets, sameMark, type Mark } from '../lib/candidates.ts';
import { core, explainProblem, toCoreProblem, type CoreProblem } from '../lib/core.ts';
import { fileFacts } from '../lib/errorReport.ts';
import { displayText, UNTRUSTED_TEXT_CLASS } from '../lib/displayText.ts';
import {
  buildRequest,
  draftIssues,
  FIELD_TYPE_LABEL,
  FIELD_TYPES,
  fieldsFromAcroFields,
  makeField,
  usableAcroFields,
  type AnchorPlacementInput,
  type DraftField,
  type FieldPatch,
  type PrepareAction,
  type PrepareState,
} from '../lib/fields.ts';
import { APP_BAR_SLOT_ID, showFieldBox, visiblePage } from '../lib/dom.ts';
import { savePacketFile, saveRequestFile } from '../lib/exports.ts';
import { clampRect, DEFAULT_FIELD_SIZE, defaultRectAt, growRect, moveRect, type PagePoint } from '../lib/geometry.ts';
import {
  cycleField,
  ghostStartRect,
  isTextEntryTarget,
  MARKERS_KEY,
  PLACE_KEY,
  REGION_KEYSHORTCUTS,
  regionKeyToCommand,
  retypeGhost,
} from '../lib/placementKeys.ts';

export interface PrepareProps {
  document: LoadedDocument;
  state: PrepareState;
  dispatch: Dispatch<PrepareAction>;
  onContinue: (request: SignRequestInput) => void;
  /** A request from a #request= link, put on the page once when the view opens. */
  initialRequest?: unknown;
  /** Called once the initial request is on the page, or the person dismissed it. */
  onInitialRequestUsed?: () => void;
  /** The sample is open: say that it is a demo with demo values, and where the data goes. */
  demo?: boolean;
}

type AnchorAlign = 'right' | 'below' | 'above' | 'over';

export function Prepare({ document: doc, state, dispatch, onContinue, initialRequest, onInitialRequestUsed, demo = false }: PrepareProps) {
  const [pages, setPages] = useState<PageInfo[]>(doc.inspection.pages);
  const [placing, setPlacing] = useState<FieldType | null>(null);
  const [exportError, setExportError] = useState<CoreProblem | null>(null);
  /** A field being placed from the keyboard: drawn, moved with the arrows, added on Enter. */
  const [ghost, setGhost] = useState<Ghost | null>(null);
  /** Numbered places for fields; null while they are being found. */
  const [marks, setMarks] = useState<Mark[] | null>(null);
  const [showMarks, setShowMarks] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** A message for the status line that is not an undoable change. */
  const [notice, setNotice] = useState<string | null>(null);
  const focusAfterAdd = useRef<string | null>(null);
  const helpId = useId();
  const regionHelpId = `${helpId}-region`;

  const pageOf = (number: number): PageInfo | undefined => pages.find((page) => page.page === number);
  const issues = useMemo(() => draftIssues(state.fields, state.signers), [state.fields, state.signers]);
  // window.signPdf and the WebMCP tools exist while this view is mounted (agent/expose.ts).
  const agent = useAgentApi({ document: () => doc, state: () => state, dispatch });
  /** The last apply_request result from the paste box or a #request= link. */
  const [applied, setApplied] = useState<AgentResult | null>(null);
  /** A link's request waits until a request is on the page or the person dismisses it. */
  const showResult = (result: AgentResult) => {
    setApplied(result);
    if (result['applied'] === true) onInitialRequestUsed?.();
  };
  const applyRequest = async (request: unknown) => showResult(await agent.apply_request({ request }));
  const dismissRequest = () => {
    setApplied(null);
    onInitialRequestUsed?.();
  };
  const initialTried = useRef(false);
  /** A link's request opens the paste box, so its result is in view. */
  const [pasteOpen] = useState(initialRequest !== undefined && !demo);
  /** The initial request is still being put on the page: the field list says so, not "No fields yet". */
  const [loadingFields, setLoadingFields] = useState(initialRequest !== undefined);
  useEffect(() => {
    if (initialRequest === undefined || initialTried.current) return;
    initialTried.current = true;
    void agent
      .apply_request({ request: initialRequest })
      .then(showResult)
      .finally(() => setLoadingFields(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per link request; showResult reads current props
  }, [agent, initialRequest]);
  const acroUsable = useMemo(() => usableAcroFields(doc.inspection.acroFields), [doc.inspection.acroFields]);
  const acroNew = useMemo(
    () => fieldsFromAcroFields(doc.inspection.acroFields, state.fields),
    [doc.inspection.acroFields, state.fields],
  );

  // Ctrl/Cmd+Z undoes the last add or removal, unless the person is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      event.preventDefault();
      dispatch({ type: 'undo' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  // Find the numbered places once per document. The resolver says where each one lands.
  useEffect(() => {
    let live = true;
    setMarks(null);
    void (async () => {
      try {
        const found = await core.findPlacementCandidates(doc.inspection);
        const targets = await resolveTargets(found.candidates, { name: doc.name, sha256: doc.sha256 }, (request) =>
          core.resolveRequest(doc.bytes, request),
        );
        if (live) setMarks(numberMarks(found.candidates, targets));
      } catch {
        if (live) setMarks([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [doc]);

  // A new undoable change replaces any notice in the status line.
  useEffect(() => setNotice(null), [state.lastChange, state.undo.length]);

  // Keep the placement box in view as it moves.
  useEffect(() => {
    if (!ghost) return;
    document.querySelector('[data-ghost]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [ghost]);

  // After a keyboard placement, focus the new field so the arrows fine-tune it.
  useEffect(() => {
    const id = focusAfterAdd.current;
    if (!id || !state.fields.some((field) => field.id === id)) return;
    focusAfterAdd.current = null;
    showFieldBox(id);
  }, [state.fields]);

  const addField = (type: FieldType, rect: Rect, label = '', at?: { anchor?: AnchorPlacementInput; acroField?: string }) => {
    const field = makeField({ type, rect, label, ...at }, state.fields.map((item) => item.id));
    dispatch({ type: 'add', field });
    return field;
  };

  const placeAt = (point: PagePoint) => {
    const page = pageOf(point.page);
    if (!placing || !page) return;
    addField(placing, defaultRectAt(placing, point, page));
    setPlacing(null);
  };

  /** Start a placement box at a numbered place, or move the current one there. */
  const goToMark = (mark: Mark, region: HTMLElement | null) => {
    setPlacing(null);
    const { placement } = mark;
    if (placement.kind === 'acroField') {
      const user = state.fields.find((field) => field.acroField === placement.name);
      if (user) {
        setNotice(`${displayText(user.label).trim() || user.id} already uses place ${mark.number} on page ${mark.page}.`);
        return;
      }
    }
    // An existing form field sets the type; elsewhere a placement box keeps its type.
    const type = placement.kind === 'acroField' || !ghost ? mark.type : ghost.type;
    setGhost({ type, rect: mark.target, mark });
    region?.focus({ preventScroll: true });
  };

  const onRegionKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A field box handles its own arrows, Delete, Enter and Escape first.
    if (event.defaultPrevented || isTextEntryTarget(event.target)) return;
    const command = regionKeyToCommand(event, ghost !== null);
    if (!command) return;
    event.preventDefault();
    const region = event.currentTarget;
    switch (command.kind) {
      case 'start': {
        setPlacing(null);
        const selected = state.fields.find((field) => field.id === state.selectedId) ?? null;
        const page = ghost
          ? pageOf(ghost.rect.page)
          : pageOf(selected?.rect.page ?? visiblePage(region));
        if (!page) return;
        const rect = ghost ? retypeGhost(ghost.rect, command.type, page) : ghostStartRect(command.type, page, selected?.rect ?? null);
        setGhost(ghost?.mark && ghost.type === command.type ? ghost : { type: command.type, rect });
        // The arrows now move the new box, not a focused field.
        region.focus({ preventScroll: true });
        return;
      }
      case 'move':
      case 'resize': {
        if (!ghost) return;
        const page = pageOf(ghost.rect.page);
        if (!page) return;
        const rect =
          command.kind === 'move'
            ? moveRect(ghost.rect, command.dx, command.dy, page)
            : growRect(ghost.rect, command.dw, command.dh, page);
        // Off the place, the field is placed by its rectangle.
        setGhost({ type: ghost.type, rect });
        return;
      }
      case 'commit': {
        if (!ghost) return;
        const placement = ghost.mark?.placement;
        const field = addField(ghost.type, ghost.rect, '', {
          ...(placement?.kind === 'anchor' ? { anchor: placement } : {}),
          ...(placement?.kind === 'acroField' ? { acroField: placement.name } : {}),
        });
        focusAfterAdd.current = field.id;
        setGhost(null);
        return;
      }
      case 'cancel':
        setGhost(null);
        setNotice('Placement cancelled.');
        return;
      case 'help':
        setShowShortcuts(true);
        return;
      case 'markers':
        toggleMarks();
        return;
      case 'jump': {
        if (marks === null) {
          setNotice('Still looking for places for fields. Try again in a moment.');
          return;
        }
        const pageNumber = visiblePage(region);
        const mark = markAt(marks, pageNumber, command.number);
        if (!mark) {
          const count = marks.filter((item) => item.page === pageNumber).length;
          setNotice(
            count === 0
              ? `Page ${pageNumber} has no numbered places.`
              : `Page ${pageNumber} has numbered places 1 to ${count}.`,
          );
          return;
        }
        if (!showMarks) setShowMarks(true);
        goToMark(mark, region);
        return;
      }
      case 'next':
      case 'previous': {
        const id = cycleField(state.fields, state.selectedId, command.kind === 'next' ? 1 : -1);
        if (!id) {
          setNotice('There are no fields yet.');
          return;
        }
        setGhost(null);
        dispatch({ type: 'select', id });
        showFieldBox(id);
        return;
      }
      case 'assignee': {
        // Act only on the field box that has focus, never on a stale selection.
        const boxId = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-field-box]')?.dataset.fieldBox : undefined;
        const field = state.fields.find((item) => item.id === boxId);
        if (!field) {
          setNotice('Focus a field first, then press A.');
          return;
        }
        const name = displayText(field.label).trim() || field.id;
        if (isSigningField(field)) {
          setNotice(`${name} is a ${FIELD_TYPE_LABEL[field.type].toLowerCase()} field: only the signer fills it.`);
          return;
        }
        // The reducer records the change for undo and the status line.
        dispatch({ type: 'setAssignee', id: field.id, assignee: field.assignee === 'agent' ? 'human' : 'agent' });
        return;
      }
    }
  };

  // Keys on a focused field box do not reach the placement box, so moving focus
  // to a field box, or out of the pages, cancels the placement.
  const cancelGhostOnFocusMove = () => {
    if (!ghost) return;
    setGhost(null);
    setNotice('Placement cancelled.');
  };
  const onRegionFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) cancelGhostOnFocusMove();
  };
  const onRegionBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) cancelGhostOnFocusMove();
  };

  const toggleMarks = () => {
    const next = !showMarks;
    setShowMarks(next);
    if (!next) setNotice('Numbered places hidden.');
    else if (marks === null) setNotice('Looking for places for fields.');
    else
      setNotice(
        marks.length === 0
          ? 'No places for fields were found. Use the field types or the form instead.'
          : `${marks.length} numbered ${marks.length === 1 ? 'place' : 'places'} shown. Press a number to start a field there.`,
      );
  };

  const statusText = ghost
    ? `Placing a ${FIELD_TYPE_LABEL[ghost.type].toLowerCase()} field ${ghost.mark ? `at place ${markLabel(ghost.mark)}` : `on page ${ghost.rect.page}, ${ghost.rect.x} pt from the left and ${ghost.rect.y} pt from the top`}. Arrow keys move it, Enter places it, Escape cancels.`
    : placing
      ? `Click the page to place a ${FIELD_TYPE_LABEL[placing].toLowerCase()} field.`
      : (notice ?? state.lastChange ?? '');

  const canvasFields: CanvasField[] = state.fields.map((field) => ({
    id: field.id,
    type: field.type,
    name: displayText(field.label).trim() || field.id,
    rect: field.rect,
    locked: field.acroField !== undefined,
    tone: field.assignee === 'agent' ? 'prefilled' : isSigningField(field) ? 'todo' : 'neutral',
  }));

  const request = (): SignRequestInput => buildRequest(state, { name: doc.name, sha256: doc.sha256 });

  const downloadRequest = () => {
    setExportError(null);
    saveRequestFile(doc.name, request());
  };

  const downloadPacket = async () => {
    setExportError(null);
    try {
      await savePacketFile(doc, request());
    } catch (error) {
      setExportError(toCoreProblem(error));
    }
  };

  const ready = issues.length === 0;
  const canContinue = state.fields.length > 0 && ready;
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setBarSlot(document.getElementById(APP_BAR_SLOT_ID)), []);
  const barControl =
    canContinue && barSlot
      ? createPortal(
          <button
            type="button"
            className="button primary app-bar-cta"
            data-testid="app-bar-sign"
            onClick={() => onContinue(request())}
          >
            Continue to sign →
          </button>,
          barSlot,
        )
      : null;

  return (
    <main className="workspace" id="main" data-view="prepare">
      {barControl}
      <PdfViewer
        pdf={doc.bytes}
        label={`Document: ${displayText(doc.name)}`}
        onPages={setPages}
        regionProps={{
          'aria-label': 'Pages',
          role: 'group',
          'aria-roledescription': 'page editor',
          'aria-describedby': regionHelpId,
          'aria-keyshortcuts': REGION_KEYSHORTCUTS,
          onKeyDown: onRegionKeyDown,
          onFocus: onRegionFocus,
          onBlur: onRegionBlur,
        }}
        toolbar={
          <div className="place-tools" role="group" aria-label="Place a field by clicking the page">
            <span className="place-tools-label" aria-hidden="true">
              Place
            </span>
            {FIELD_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="button toggle"
                aria-pressed={placing === type}
                aria-keyshortcuts={PLACE_KEY[type]}
                data-testid={`place-${type}`}
                onClick={() => {
                  setGhost(null);
                  setPlacing(placing === type ? null : type);
                }}
              >
                {FIELD_TYPE_LABEL[type]}
              </button>
            ))}
            <button
              type="button"
              className="button quiet icon shortcut-button"
              aria-label="Keyboard shortcuts"
              aria-keyshortcuts="Shift+?"
              title="Keyboard shortcuts (?)"
              data-testid="show-shortcuts"
              onClick={() => setShowShortcuts(true)}
            >
              <span aria-hidden="true">?</span>
            </button>
          </div>
        }
        renderOverlay={(page, scale) => (
          <FieldCanvas
            page={page}
            scale={scale}
            fields={canvasFields}
            selectedId={state.selectedId}
            onSelect={(id) => dispatch({ type: 'select', id })}
            onChangeRect={(id, rect) => dispatch({ type: 'setRect', id, rect, at: Date.now() })}
            onDelete={(id) => dispatch({ type: 'remove', id })}
            placingType={placing}
            onPlace={placeAt}
            renderContent={(canvasField) => {
              const draft = state.fields.find((item) => item.id === canvasField.id);
              if (draft?.type === 'checkbox') return draft.value === true ? '✓' : '';
              return typeof draft?.value === 'string' && draft.value !== '' ? draft.value : canvasField.name;
            }}
            helpId={helpId}
            ghost={ghost}
            marks={showMarks && marks ? marks : undefined}
            activeMark={ghost?.mark ?? null}
          />
        )}
      />

      <aside className="panel" aria-label="Fields">
        <FieldKeyboardHelp id={helpId} canDelete />
        <p id={regionHelpId} className="visually-hidden">
          Press T, D, C, S or I to start placing a text, date, checkbox, signature or initials field.
          Arrow keys move it, Enter places it, Escape cancels. Press M to show numbered places, and a
          number to start a field at that place. Press ] or [ to go through the fields, and ? for all
          keyboard shortcuts.
        </p>
        <header className="panel-header">
          <h1>Place the fields</h1>
          <p className={`doc-name ${UNTRUSTED_TEXT_CLASS}`} data-testid="document-name">
            {displayText(doc.name)}
          </p>
          {demo && (
            <div className="notice demo-notice" data-testid="demo-notice">
              <p>
                <strong>Demo.</strong> This sample NDA has five fields with demo values. Party A, Party B,
                the date and your name are filled in. You sign and confirm.
              </p>
              <p className={UNTRUSTED_TEXT_CLASS}>{displayText(state.details.note)}</p>
              <p>The PDF and what you type stay in this browser. Nothing is uploaded.</p>
            </div>
          )}
          {canContinue && (
            <button
              type="button"
              className="button primary"
              data-testid="header-continue-to-sign"
              onClick={() => onContinue(request())}
            >
              Continue to sign
            </button>
          )}
          <p className="hint">
            Pick a field type above the page and click where it goes, or add it with the form below.
            Drag a field to move it; with the keyboard, focus it and use the arrow keys. With the page
            focused, press T, D, C, S or I to place a field from the keyboard, and ? for all shortcuts.
          </p>
        </header>

        <p className="status-line" role="status" aria-live="polite" data-testid="prepare-status">
          {statusText}{' '}
          {state.undo.length > 0 && !placing && !ghost && (
            <button type="button" className="link-button" data-testid="undo" onClick={() => dispatch({ type: 'undo' })}>
              Undo
            </button>
          )}
        </p>

        {acroUsable.length > 0 && (
          <section className="panel-section" aria-labelledby={`${helpId}-acro`}>
            <h2 id={`${helpId}-acro`}>Existing form fields</h2>
            <p>
              This PDF already has {acroUsable.length} form {acroUsable.length === 1 ? 'field' : 'fields'}.
              You can reuse their positions.
            </p>
            <button
              type="button"
              className="button"
              data-testid="use-acro-fields"
              disabled={acroNew.length === 0}
              onClick={() => dispatch({ type: 'addMany', fields: acroNew })}
            >
              {acroNew.length === 0 ? 'Form fields added' : `Use existing form fields (${acroNew.length})`}
            </button>
          </section>
        )}

        <PlacesSection
          headingId={`${helpId}-places`}
          marks={marks}
          shown={showMarks}
          active={ghost?.mark ?? null}
          onToggle={toggleMarks}
          onGo={(mark) => goToMark(mark, document.querySelector<HTMLElement>('.viewer-scroll'))}
        />

        <AddFieldForm
          document={doc}
          pages={pages}
          onAdd={(type, rect, label, anchor) => addField(type, rect, label, anchor ? { anchor } : undefined)}
        />

        <section className="panel-section" aria-labelledby={`${helpId}-list`}>
          <h2 id={`${helpId}-list`}>
            Fields <span className="count" data-testid="field-count">{state.fields.length}</span>
          </h2>
          {state.fields.length === 0 && loadingFields ? (
            <p className="empty" role="status" data-testid="fields-loading">
              Loading the fields…
            </p>
          ) : state.fields.length === 0 ? (
            <p className="empty" data-testid="no-fields">
              No fields yet. Add the first one above.
            </p>
          ) : (
            <ol className="field-list">
              {state.fields.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  pages={pages}
                  selected={field.id === state.selectedId}
                  issue={issues.find((issue) => issue.fieldId === field.id)?.message}
                  dispatch={dispatch}
                />
              ))}
            </ol>
          )}
        </section>

        <section className="panel-section" aria-labelledby={`${helpId}-details`}>
          <h2 id={`${helpId}-details`}>Note to the signer</h2>
          <DetailsForm state={state} dispatch={dispatch} />
        </section>

        <RequestPasteBox
          result={applied}
          onApply={applyRequest}
          open={pasteOpen}
          {...(initialRequest !== undefined ? { onDismiss: dismissRequest } : {})}
        />

        <section className="panel-section export" aria-labelledby={`${helpId}-export`}>
          <h2 id={`${helpId}-export`}>Hand it over</h2>
          {!ready && (
            <ul className="issues" data-testid="draft-issues" id={`${helpId}-issues`}>
              {issues.map((issue) => (
                <li key={`${issue.fieldId ?? ''}${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          )}
          {exportError && (
            <div className="form-error" role="alert" data-testid="export-error">
              <p>
                {explainProblem(exportError)} ({exportError.message})
              </p>
              <ErrorDetails failure={exportError} file={fileFacts(doc.name, doc.bytes.length)} />
            </div>
          )}
          <div className="button-column">
            <button
              type="button"
              className="button primary"
              data-testid="continue-to-sign"
              disabled={!ready}
              aria-describedby={!ready ? `${helpId}-issues` : undefined}
              onClick={() => onContinue(request())}
            >
              Continue to sign
            </button>
            <button
              type="button"
              className="button"
              data-testid="download-packet"
              disabled={!ready}
              onClick={() => void downloadPacket()}
            >
              Download packet for the signer
            </button>
            <button type="button" className="button" data-testid="download-request" disabled={!ready} onClick={downloadRequest}>
              Download request JSON
            </button>
          </div>
          <p className="hint">
            The packet holds the PDF and the fields in one file. The request JSON holds the fields
            only.
          </p>
        </section>
      </aside>
      {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}
    </main>
  );
}

// ---------------------------------------------------------------------------

/** The placement box. `mark` is set while it sits on a numbered place, so the field keeps that place's placement. */
interface Ghost {
  type: FieldType;
  rect: Rect;
  mark?: Mark;
}

interface PlacesSectionProps {
  headingId: string;
  marks: Mark[] | null;
  shown: boolean;
  active: Mark | null;
  onToggle: () => void;
  onGo: (mark: Mark) => void;
}

/**
 * The numbered places as a list of buttons: the same places the markers show,
 * readable as text by a screen reader or a browser agent.
 */
function PlacesSection({ headingId, marks, shown, active, onToggle, onGo }: PlacesSectionProps) {
  return (
    <section className="panel-section" aria-labelledby={headingId} data-testid="places">
      <h2 id={headingId}>
        Suggested places{' '}
        {marks !== null && (
          <span className="count" data-testid="place-count">
            {marks.length}
          </span>
        )}
      </h2>
      <p>
        Places where a field likely goes: after a label, on a line, or on an existing form field.
        Numbers count from 1 on each page.
      </p>
      <div className="place-tools-row">
        <button
          type="button"
          className="button toggle"
          aria-pressed={shown}
          aria-keyshortcuts={MARKERS_KEY}
          title={`Show numbered places (${MARKERS_KEY})`}
          data-testid="toggle-places"
          disabled={marks !== null && marks.length === 0}
          onClick={onToggle}
        >
          {shown ? 'Hide numbered places' : 'Show numbered places'}
        </button>
      </div>
      {marks === null ? (
        <p className="hint">Looking for places…</p>
      ) : marks.length === 0 ? (
        <p className="empty">No places found. Use the field types above the page or the form below.</p>
      ) : (
        shown && (
          <ol className="place-list" aria-label="Numbered places" data-testid="place-list">
            {marks.map((mark) => (
              <li key={`${mark.page}-${mark.number}`}>
                <button
                  type="button"
                  className="place-item"
                  aria-current={active && sameMark(active, mark) ? 'true' : undefined}
                  data-testid={`place-${mark.page}-${mark.number}`}
                  onClick={() => onGo(mark)}
                >
                  <span className={`place-item-text ${UNTRUSTED_TEXT_CLASS}`}>
                    <span className="place-item-number">{mark.number}</span>
                    {markLabel(mark).slice(String(mark.number).length)}
                  </span>
                  <span className="type-chip" data-type={mark.type}>
                    {FIELD_TYPE_LABEL[mark.type]}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )
      )}
    </section>
  );
}

interface AddFieldFormProps {
  document: LoadedDocument;
  pages: PageInfo[];
  onAdd: (type: FieldType, rect: Rect, label: string, anchor?: AnchorPlacementInput) => DraftField;
}

/** Add a field with no pointer: by coordinates, or next to text printed on the page. */
function AddFieldForm({ document: doc, pages, onAdd }: AddFieldFormProps) {
  const ids = useId();
  const [type, setType] = useState<FieldType>('text');
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<'coords' | 'anchor'>('coords');
  const [page, setPage] = useState(1);
  const [x, setX] = useState(72);
  const [y, setY] = useState(72);
  const [width, setWidth] = useState(DEFAULT_FIELD_SIZE.text.width);
  const [height, setHeight] = useState(DEFAULT_FIELD_SIZE.text.height);
  const [anchorText, setAnchorText] = useState('');
  const [anchorAnyPage, setAnchorAnyPage] = useState(true);
  const [align, setAlign] = useState<AnchorAlign>('right');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chooseType = (next: FieldType) => {
    setType(next);
    setWidth(DEFAULT_FIELD_SIZE[next].width);
    setHeight(DEFAULT_FIELD_SIZE[next].height);
  };

  const add = async () => {
    setError(null);
    if (mode === 'coords') {
      const info = pages.find((item) => item.page === page);
      if (!info) {
        setError(`This document has ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}. Choose a page from 1 to ${pages.length}.`);
        return;
      }
      onAdd(type, clampRect({ page, x, y, width, height }, info), label);
      setLabel('');
      return;
    }
    if (!anchorText.trim()) {
      setError('Type the text the field should sit next to.');
      return;
    }
    setBusy(true);
    try {
      // The core resolver is the one authority on anchors: ask it where the
      // field lands. The field keeps the anchor until it is moved.
      const anchor: AnchorPlacementInput = {
        kind: 'anchor',
        text: anchorText.trim(),
        ...(anchorAnyPage ? {} : { page }),
        align,
        width,
        height,
      };
      const resolved = await core.resolveRequest(doc.bytes, {
        version: 1,
        document: { name: doc.name, sha256: doc.sha256 },
        fields: [{ id: 'probe', type: 'text', assignee: 'human', placement: anchor }],
      });
      const rect = resolved.fields[0]?.rect;
      if (!rect) throw new Error('no rectangle returned');
      onAdd(type, rect, label, anchor);
      setLabel('');
    } catch (failure) {
      const problem = toCoreProblem(failure);
      setError(
        problem.code === 'anchor-not-found'
          ? `“${anchorText.trim()}” was not found ${anchorAnyPage ? 'in the document' : `on page ${page}`}.`
          : `${explainProblem(problem)} (${problem.message})`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-section" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Add a field</h2>
      <div className="form-grid">
        <div className="form-item">
          <label htmlFor={`${ids}-type`}>Type</label>
          <select
            id={`${ids}-type`}
            className="input"
            data-testid="add-type"
            value={type}
            onChange={(event) => chooseType(event.target.value as FieldType)}
          >
            {FIELD_TYPES.map((item) => (
              <option key={item} value={item}>
                {FIELD_TYPE_LABEL[item]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-item grow">
          <label htmlFor={`${ids}-label`}>Label</label>
          <input
            id={`${ids}-label`}
            className="input"
            type="text"
            maxLength={200}
            data-testid="add-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
      </div>

      <fieldset className="radio-row">
        <legend>Position</legend>
        <label>
          <input
            type="radio"
            name={`${ids}-mode`}
            data-testid="add-mode-coords"
            checked={mode === 'coords'}
            onChange={() => setMode('coords')}
          />
          <span>At coordinates</span>
        </label>
        <label>
          <input
            type="radio"
            name={`${ids}-mode`}
            data-testid="add-mode-anchor"
            checked={mode === 'anchor'}
            onChange={() => setMode('anchor')}
          />
          <span>Next to text</span>
        </label>
      </fieldset>

      {mode === 'anchor' && (
        <div className="form-grid">
          <div className="form-item grow">
            <label htmlFor={`${ids}-anchor`}>Text on the page</label>
            <input
              id={`${ids}-anchor`}
              className="input"
              type="text"
              maxLength={200}
              placeholder="Signature:"
              data-testid="add-anchor-text"
              value={anchorText}
              onChange={(event) => setAnchorText(event.target.value)}
            />
          </div>
          <div className="form-item">
            <label htmlFor={`${ids}-align`}>Field goes</label>
            <select
              id={`${ids}-align`}
              className="input"
              data-testid="add-anchor-align"
              value={align}
              onChange={(event) => setAlign(event.target.value as AnchorAlign)}
            >
              <option value="right">to the right of it</option>
              <option value="below">below it</option>
              <option value="above">above it</option>
              <option value="over">on top of it</option>
            </select>
          </div>
          <label className="check-row wide">
            <input
              type="checkbox"
              data-testid="add-anchor-any-page"
              checked={anchorAnyPage}
              onChange={(event) => setAnchorAnyPage(event.target.checked)}
            />
            <span>Search every page</span>
          </label>
        </div>
      )}

      <div className="number-grid">
        {(mode === 'coords' || !anchorAnyPage) && (
          <NumberField label="Page" value={page} min={1} max={Math.max(1, pages.length)} step={1} testId="add-page" onCommit={(value) => setPage(Math.round(value))} />
        )}
        {mode === 'coords' && (
          <>
            <NumberField label="From left" unit="pt" value={x} min={0} testId="add-x" onCommit={setX} />
            <NumberField label="From top" unit="pt" value={y} min={0} testId="add-y" onCommit={setY} />
          </>
        )}
        <NumberField label="Width" unit="pt" value={width} min={1} testId="add-width" onCommit={setWidth} />
        <NumberField label="Height" unit="pt" value={height} min={1} testId="add-height" onCommit={setHeight} />
      </div>
      <p className="hint">Sizes are in points: 72 points make one inch. A US Letter page is 612 by 792.</p>

      {error && (
        <p className="form-error" role="alert" data-testid="add-error">
          {error}
        </p>
      )}
      <button type="button" className="button" data-testid="add-field" disabled={busy} onClick={() => void add()}>
        Add field
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------

interface FieldRowProps {
  field: DraftField;
  pages: PageInfo[];
  selected: boolean;
  issue: string | undefined;
  dispatch: Dispatch<PrepareAction>;
}

function FieldRow({ field, pages, selected, issue, dispatch }: FieldRowProps) {
  const ids = useId();
  const signing = isSigningField(field);
  const locked = field.acroField !== undefined;
  const update = (patch: FieldPatch) => dispatch({ type: 'update', id: field.id, patch });

  const setRect = (patch: Partial<Rect>) => {
    const next = { ...field.rect, ...patch };
    const page = pages.find((item) => item.page === next.page);
    if (!page) return;
    dispatch({ type: 'setRect', id: field.id, rect: next, page, at: Date.now() });
  };

  return (
    <li
      className="field-row"
      data-testid={`field-row-${field.id}`}
      data-selected={selected ? 'true' : undefined}
      onFocusCapture={() => dispatch({ type: 'select', id: field.id })}
    >
      <fieldset>
        <legend>
          <span className="type-chip" data-type={field.type}>
            {FIELD_TYPE_LABEL[field.type]}
          </span>{' '}
          <span className="field-id">{field.id}</span>
        </legend>

        <div className="form-grid">
          <div className="form-item grow">
            <label htmlFor={`${ids}-label`}>Label</label>
            <input
              id={`${ids}-label`}
              className="input"
              type="text"
              maxLength={200}
              data-testid={`field-label-${field.id}`}
              value={field.label}
              onChange={(event) => update({ label: event.target.value })}
            />
          </div>
          <div className="form-item">
            <label htmlFor={`${ids}-type`}>Type</label>
            <select
              id={`${ids}-type`}
              className="input"
              data-testid={`field-type-${field.id}`}
              value={field.type}
              onChange={(event) => update({ type: event.target.value as FieldType })}
            >
              {FIELD_TYPES.map((item) => (
                <option key={item} value={item}>
                  {FIELD_TYPE_LABEL[item]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-grid">
          <div className="form-item grow">
            <label htmlFor={`${ids}-assignee`}>Filled by</label>
            <select
              id={`${ids}-assignee`}
              className="input"
              data-testid={`field-assignee-${field.id}`}
              value={field.assignee}
              disabled={signing}
              aria-describedby={signing ? `${ids}-signing` : undefined}
              onChange={(event) => update({ assignee: event.target.value === 'agent' ? 'agent' : 'human' })}
            >
              <option value="human">The signer (human)</option>
              {!signing && <option value="agent">The preparer (agent)</option>}
            </select>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              data-testid={`field-required-${field.id}`}
              checked={field.required}
              onChange={(event) => update({ required: event.target.checked })}
            />
            <span>Required</span>
          </label>
        </div>

        {signing ? (
          <p className="hint" id={`${ids}-signing`}>
            Only the signer can fill this field, in the sign view.
          </p>
        ) : field.type === 'checkbox' ? (
          <label className="check-row">
            <input
              type="checkbox"
              data-testid={`field-value-${field.id}`}
              checked={field.value === true}
              onChange={(event) => update({ value: event.target.checked })}
            />
            <span>Checked</span>
          </label>
        ) : (
          <div className="form-item">
            <label htmlFor={`${ids}-value`}>
              {field.assignee === 'agent' ? 'Value' : 'Starting value (optional)'}
            </label>
            <input
              id={`${ids}-value`}
              className="input"
              type={field.type === 'date' ? 'date' : 'text'}
              maxLength={field.type === 'text' ? 5000 : undefined}
              data-testid={`field-value-${field.id}`}
              aria-invalid={issue ? 'true' : undefined}
              aria-describedby={issue ? `${ids}-issue` : undefined}
              value={typeof field.value === 'string' ? field.value : ''}
              onChange={(event) => update({ value: event.target.value })}
            />
          </div>
        )}
        {issue && (
          <p className="form-error" id={`${ids}-issue`} data-testid={`field-issue-${field.id}`}>
            {issue}
          </p>
        )}

        {locked ? (
          <p className="hint">
            Uses the position of the form field “{field.acroField}”.{' '}
            <button
              type="button"
              className="link-button"
              data-testid={`field-unlink-${field.id}`}
              onClick={() => dispatch({ type: 'unlink', id: field.id })}
            >
              Position it freely instead
            </button>
          </p>
        ) : (
          <>
            {field.anchor && (
              <p className="hint" data-testid={`field-anchor-${field.id}`}>
                Placed next to the text <span className={UNTRUSTED_TEXT_CLASS}>“{displayText(field.anchor.text)}”</span>.
                Moving it places it by position instead.
              </p>
            )}
            <div className="number-grid">
              <NumberField label="Page" value={field.rect.page} min={1} max={Math.max(1, pages.length)} step={1} testId={`field-page-${field.id}`} onCommit={(value) => setRect({ page: Math.round(value) })} />
              <NumberField label="From left" unit="pt" value={field.rect.x} min={0} testId={`field-x-${field.id}`} onCommit={(value) => setRect({ x: value })} />
              <NumberField label="From top" unit="pt" value={field.rect.y} min={0} testId={`field-y-${field.id}`} onCommit={(value) => setRect({ y: value })} />
              <NumberField label="Width" unit="pt" value={field.rect.width} min={1} testId={`field-width-${field.id}`} onCommit={(value) => setRect({ width: value })} />
              <NumberField label="Height" unit="pt" value={field.rect.height} min={1} testId={`field-height-${field.id}`} onCommit={(value) => setRect({ height: value })} />
            </div>
          </>
        )}

        <div className="row-actions">
          <button
            type="button"
            className="button quiet"
            data-testid={`field-show-${field.id}`}
            onClick={() => showFieldBox(field.id)}
          >
            <span aria-hidden="true">📍</span> Jump to
          </button>
          <button
            type="button"
            className="button quiet danger"
            data-testid={`field-remove-${field.id}`}
            onClick={() => dispatch({ type: 'remove', id: field.id })}
          >
            Remove
          </button>
        </div>
      </fieldset>
    </li>
  );
}

function DetailsForm({ state, dispatch }: { state: PrepareState; dispatch: Dispatch<PrepareAction> }) {
  const ids = useId();
  return (
    <div className="details-form">
      <div className="form-item">
        <label htmlFor={`${ids}-title`}>Title (optional)</label>
        <input
          id={`${ids}-title`}
          className="input"
          type="text"
          maxLength={200}
          data-testid="details-title"
          value={state.details.title}
          onChange={(event) => dispatch({ type: 'details', patch: { title: event.target.value } })}
        />
      </div>
      <div className="form-item">
        <label htmlFor={`${ids}-note`}>Note (optional)</label>
        <textarea
          id={`${ids}-note`}
          className="input"
          rows={3}
          maxLength={2000}
          data-testid="details-note"
          value={state.details.note}
          onChange={(event) => dispatch({ type: 'details', patch: { note: event.target.value } })}
        />
      </div>
      <div className="form-item">
        <label htmlFor={`${ids}-signer`}>Signer’s name, if known (optional)</label>
        <input
          id={`${ids}-signer`}
          className="input"
          type="text"
          maxLength={200}
          autoComplete="off"
          data-testid="details-signer"
          value={state.details.signerName}
          onChange={(event) => dispatch({ type: 'details', patch: { signerName: event.target.value } })}
        />
      </div>
    </div>
  );
}
