/**
 * Prepare-side field state: the draft a person or browser agent edits before
 * it becomes a SignRequest. Pure functions and one reducer; no DOM.
 */
import {
  FieldId,
  isSigningField,
  SPEC_VERSION,
  type FieldInput,
  type FieldType,
  type PageInfo,
  type PlacementInput,
  type Rect,
  type Signer,
  type SignRequestInput,
} from '@sign-pdf/spec';
import type { AcroFieldInfo } from './core.ts';
import { acroFieldLabel } from '@sign-pdf/core/labels';
import { clampRect } from './geometry.ts';

export type Assignee = 'agent' | 'human';

/** A placement next to text printed on the page, as the request states it. */
export type AnchorPlacementInput = Extract<PlacementInput, { kind: 'anchor' }>;

export interface DraftField {
  id: string;
  type: FieldType;
  label: string;
  assignee: Assignee;
  required: boolean;
  /** Text and date fields hold a string, checkboxes a boolean. Never set on signing fields. */
  value?: string | boolean;
  /** Where the box is drawn. Always present, whatever the placement kind. */
  rect: Rect;
  /** Set when the field reuses an existing form field; its position is then fixed. */
  acroField?: string;
  /**
   * Set when the field was placed next to printed text and has not moved
   * since. `rect` is where that anchor resolves. Moving or resizing the field
   * drops it, so the field is then placed by its rectangle.
   */
  anchor?: AnchorPlacementInput;
  /** In a draft with signers: the signer who fills this human field. Never set on agent fields. */
  signerId?: string;
}

export interface DocumentDetails {
  title: string;
  note: string;
  signerName: string;
}

export interface PrepareState {
  fields: DraftField[];
  selectedId: string | null;
  details: DocumentDetails;
  /**
   * The people who sign in turn, when the draft came from a request with
   * `signers` (apply_request, the paste box). Empty for one signer.
   */
  signers: Signer[];
  /** Snapshots of `fields` to return to; newest last. */
  undo: DraftField[][];
  /** What the last undoable change was, for the status line. */
  lastChange: string | null;
  /**
   * The last timed move or resize, so a burst of nudges or one drag becomes a
   * single undo step. `fields` is the array that move produced: any other
   * change in between replaces it, which ends the burst.
   */
  rectBurst?: { id: string; at: number; fields: DraftField[] } | null;
}

export const emptyPrepareState: PrepareState = {
  fields: [],
  selectedId: null,
  details: { title: '', note: '', signerName: '' },
  signers: [],
  undo: [],
  lastChange: null,
};

const UNDO_LIMIT = 50;
/** Moves of one field closer together than this are one undo step. */
export const RECT_BURST_MS = 1000;

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  date: 'Date',
  checkbox: 'Checkbox',
  signature: 'Signature',
  initials: 'Initials',
};

export const FIELD_TYPES: readonly FieldType[] = ['text', 'date', 'checkbox', 'signature', 'initials'];

/** The next free id for a type: text1, text2, signature1 … */
export function nextFieldId(type: FieldType, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const id = `${type}${n}`;
    if (!used.has(id)) return id;
  }
}

export interface NewFieldInput {
  type: FieldType;
  rect: Rect;
  label?: string;
  assignee?: Assignee;
  acroField?: string;
  anchor?: AnchorPlacementInput;
  value?: string | boolean;
}

export function makeField(input: NewFieldInput, taken: Iterable<string>): DraftField {
  const signing = isSigningField(input);
  const field: DraftField = {
    id: nextFieldId(input.type, taken),
    type: input.type,
    label: input.label ?? '',
    assignee: signing ? 'human' : (input.assignee ?? 'human'),
    required: true,
    rect: input.rect,
  };
  if (input.acroField !== undefined) field.acroField = input.acroField;
  else if (input.anchor !== undefined) field.anchor = input.anchor;
  if (!signing && input.value !== undefined) field.value = input.value;
  return normalizeField(field);
}

/**
 * Enforce the rules the schema also enforces, at edit time:
 * signing fields belong to the human and never hold a value; a checkbox holds
 * a boolean; text and date hold strings.
 */
export function normalizeField(field: DraftField): DraftField {
  const next: DraftField = { ...field };
  if (next.assignee === 'agent') delete next.signerId;
  if (isSigningField(next)) {
    next.assignee = 'human';
    delete next.value;
    return next;
  }
  if (next.type === 'checkbox') {
    if (typeof next.value !== 'boolean') {
      if (next.assignee === 'agent') next.value = false;
      else delete next.value;
    }
    return next;
  }
  if (typeof next.value !== 'string') delete next.value;
  return next;
}

export type FieldPatch = Partial<Pick<DraftField, 'label' | 'type' | 'assignee' | 'required' | 'value'>>;

export type PrepareAction =
  | { type: 'add'; field: DraftField }
  | { type: 'addMany'; fields: DraftField[] }
  | { type: 'update'; id: string; patch: FieldPatch }
  | { type: 'rename'; id: string; newId: string }
  | {
      type: 'setRect';
      id: string;
      rect: Rect;
      page?: Pick<PageInfo, 'width' | 'height'>;
      /** When the change happened (ms). With it, close moves of one field coalesce into one undo step. */
      at?: number;
    }
  | { type: 'unlink'; id: string }
  | { type: 'remove'; id: string }
  /** Who fills a field. Unlike `update`, one undo step restores the old assignee and value. */
  | { type: 'setAssignee'; id: string; assignee: Assignee }
  | { type: 'undo' }
  | { type: 'select'; id: string | null }
  | { type: 'details'; patch: Partial<DocumentDetails> }
  /** Put a whole request's fields on the page (apply_request, the paste box). One undo step restores the earlier fields. */
  | { type: 'replace'; fields: DraftField[]; details: DocumentDetails; signers: Signer[] }
  | { type: 'reset'; state?: PrepareState };

function withUndo(state: PrepareState, fields: DraftField[], lastChange: string): PrepareState {
  return {
    ...state,
    fields,
    undo: [...state.undo, state.fields].slice(-UNDO_LIMIT),
    lastChange,
  };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.page === b.page && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function nameOf(field: DraftField): string {
  return field.label.trim() || field.id;
}

export function prepareReducer(state: PrepareState, action: PrepareAction): PrepareState {
  switch (action.type) {
    case 'add': {
      if (state.fields.some((field) => field.id === action.field.id)) return state;
      const next = withUndo(state, [...state.fields, action.field], `Added ${nameOf(action.field)}.`);
      return { ...next, selectedId: action.field.id };
    }
    case 'addMany': {
      const taken = new Set(state.fields.map((field) => field.id));
      const fresh = action.fields.filter((field) => !taken.has(field.id));
      if (fresh.length === 0) return state;
      return withUndo(state, [...state.fields, ...fresh], `Added ${fresh.length} fields.`);
    }
    case 'update': {
      let changed = false;
      const fields = state.fields.map((field) => {
        if (field.id !== action.id) return field;
        changed = true;
        return normalizeField({ ...field, ...action.patch });
      });
      return changed ? { ...state, fields } : state;
    }
    case 'setAssignee': {
      const target = state.fields.find((field) => field.id === action.id);
      if (!target || target.assignee === action.assignee) return state;
      const fields = state.fields.map((field) =>
        field === target ? normalizeField({ ...field, assignee: action.assignee }) : field,
      );
      const who = action.assignee === 'agent' ? 'preparer' : 'signer';
      return withUndo(state, fields, `${nameOf(target)} is now filled by the ${who}.`);
    }
    case 'rename': {
      const newId = action.newId.trim();
      if (newId === action.id) return state;
      if (!FieldId.safeParse(newId).success) return state;
      if (state.fields.some((field) => field.id === newId)) return state;
      return {
        ...state,
        fields: state.fields.map((field) => (field.id === action.id ? { ...field, id: newId } : field)),
        selectedId: state.selectedId === action.id ? newId : state.selectedId,
      };
    }
    case 'setRect': {
      const target = state.fields.find((field) => field.id === action.id);
      if (!target || target.acroField !== undefined) return state;
      const rect = action.page ? clampRect(action.rect, action.page) : action.rect;
      if (sameRect(rect, target.rect)) return state;
      const fields = state.fields.map((field) => {
        if (field.id !== action.id) return field;
        // A moved field no longer sits where its anchor puts it: it is placed by its rectangle from now on.
        const { anchor: _dropped, ...rest } = field;
        return { ...rest, rect };
      });
      const burst = state.rectBurst;
      const coalesce =
        action.at !== undefined &&
        burst?.id === action.id &&
        burst.fields === state.fields &&
        action.at - burst.at <= RECT_BURST_MS;
      const next = coalesce ? { ...state, fields } : withUndo(state, fields, `Moved ${nameOf(target)}.`);
      return { ...next, rectBurst: action.at === undefined ? null : { id: action.id, at: action.at, fields } };
    }
    case 'unlink': {
      const fields = state.fields.map((field) => {
        if (field.id !== action.id || field.acroField === undefined) return field;
        const { acroField: _dropped, ...rest } = field;
        return rest;
      });
      return { ...state, fields };
    }
    case 'remove': {
      const target = state.fields.find((field) => field.id === action.id);
      if (!target) return state;
      const next = withUndo(
        state,
        state.fields.filter((field) => field.id !== action.id),
        `Removed ${nameOf(target)}.`,
      );
      return { ...next, selectedId: state.selectedId === action.id ? null : state.selectedId };
    }
    case 'undo': {
      const previous = state.undo.at(-1);
      if (!previous) return state;
      const stillThere = previous.some((field) => field.id === state.selectedId);
      return {
        ...state,
        fields: previous,
        undo: state.undo.slice(0, -1),
        selectedId: stillThere ? state.selectedId : null,
        lastChange: 'Undone.',
        rectBurst: null,
      };
    }
    case 'select':
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
    case 'details':
      return { ...state, details: { ...state.details, ...action.patch } };
    case 'replace': {
      const count = action.fields.length;
      const next = withUndo(state, action.fields, `Applied a request with ${count} ${count === 1 ? 'field' : 'fields'}.`);
      return { ...next, details: action.details, signers: action.signers, selectedId: null, rectBurst: null };
    }
    case 'reset':
      return action.state ?? emptyPrepareState;
  }
}

// ---------------------------------------------------------------------------
// Draft -> request

function placementOf(field: DraftField): PlacementInput {
  if (field.acroField !== undefined) return { kind: 'acroField', name: field.acroField };
  if (field.anchor !== undefined) return field.anchor;
  return { kind: 'rect', ...field.rect };
}

export function fieldToInput(field: DraftField): FieldInput {
  const base = {
    id: field.id,
    placement: placementOf(field),
    required: field.required,
    ...(field.label.trim() ? { label: field.label.trim() } : {}),
    ...(field.assignee === 'human' && field.signerId !== undefined ? { signerId: field.signerId } : {}),
  };
  switch (field.type) {
    case 'signature':
    case 'initials':
      return { ...base, type: field.type, assignee: 'human' };
    case 'checkbox':
      return {
        ...base,
        type: 'checkbox',
        assignee: field.assignee,
        ...(typeof field.value === 'boolean' ? { value: field.value } : {}),
      };
    case 'text':
    case 'date':
      return {
        ...base,
        type: field.type,
        assignee: field.assignee,
        ...(typeof field.value === 'string' && field.value !== '' ? { value: field.value } : {}),
      };
  }
}

export function buildRequest(
  state: Pick<PrepareState, 'fields' | 'details'> & Partial<Pick<PrepareState, 'signers'>>,
  document: { name: string; sha256: string },
): SignRequestInput {
  const { title, note, signerName } = state.details;
  const signers = state.signers ?? [];
  return {
    version: SPEC_VERSION,
    document,
    ...(title.trim() ? { title: title.trim() } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
    // A request names one expected signer, or a list of signers in turn; never both.
    ...(signers.length > 0 ? { signers } : signerName.trim() ? { signer: { name: signerName.trim() } } : {}),
    fields: state.fields.map(fieldToInput),
  };
}

export interface DraftIssue {
  fieldId?: string;
  message: string;
}

/** Why the draft cannot be exported yet, in plain language. Empty means ready. */
export function draftIssues(fields: readonly DraftField[], signers: readonly Signer[] = []): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (fields.length === 0) {
    issues.push({ message: 'Add at least one field.' });
    return issues;
  }
  const signerIds = new Set(signers.map((signer) => signer.id));
  for (const field of fields) {
    if (signers.length > 0 && field.assignee === 'human' && (field.signerId === undefined || !signerIds.has(field.signerId))) {
      issues.push({
        fieldId: field.id,
        message: `${nameOf(field)} has no signer. Apply a request that gives it a signerId, or remove it.`,
      });
      continue;
    }
    if (isSigningField(field) || field.assignee !== 'agent') continue;
    const missing =
      field.type === 'checkbox' ? typeof field.value !== 'boolean' : !field.value || field.value === '';
    if (missing) {
      issues.push({
        fieldId: field.id,
        message: `${nameOf(field)} is filled by the preparer, so it needs a value.`,
      });
    } else if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(field.value))) {
      issues.push({ fieldId: field.id, message: `${nameOf(field)} needs a full date.` });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Existing form fields

const ACRO_TYPE: Partial<Record<AcroFieldInfo['type'], FieldType>> = {
  text: 'text',
  checkbox: 'checkbox',
  signature: 'signature',
};

/** Which existing form fields can become placements (visible, writable, supported type). */
export function usableAcroFields(acroFields: readonly AcroFieldInfo[]): AcroFieldInfo[] {
  return acroFields.filter(
    (info) => ACRO_TYPE[info.type] !== undefined && info.rect !== undefined && !info.readOnly,
  );
}

export function fieldsFromAcroFields(
  acroFields: readonly AcroFieldInfo[],
  existing: readonly DraftField[],
): DraftField[] {
  const taken = new Set(existing.map((field) => field.id));
  const linked = new Set(existing.map((field) => field.acroField).filter((name) => name !== undefined));
  const created: DraftField[] = [];
  const usable = new Set(usableAcroFields(acroFields));
  for (const [index, info] of acroFields.entries()) {
    const type = ACRO_TYPE[info.type];
    if (!usable.has(info) || !type || !info.rect || linked.has(info.name)) continue;
    // A name cut from the page text ("day of") reads as a value: use a plain label (core labels.ts).
    const field = makeField({ type, rect: info.rect, label: acroFieldLabel(info, index + 1), acroField: info.name }, taken);
    taken.add(field.id);
    created.push(field);
  }
  return created;
}

/** A rectangle in words, for accessible names. */
export function describeRect(rect: Rect): string {
  return `page ${rect.page}, ${rect.x} pt from the left, ${rect.y} pt from the top, ${rect.width} by ${rect.height} pt`;
}
