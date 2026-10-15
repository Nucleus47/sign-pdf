/**
 * Prepare-side API: everything an agent, CLI, MCP server or the web app needs
 * up to the moment of signing. Nothing here accepts a signature.
 *
 * The signing step lives in `@sign-pdf/core/sign` and is imported only by the
 * web sign view.
 */
import type {
  AuditRecord,
  Packet,
  PageInfo,
  Rect,
  SignRequestInput,
} from '@sign-pdf/spec';
import {
  findPlacementCandidates as findPlacementCandidatesImpl,
  type FindPlacementCandidatesOptions,
  type PlacementCandidate,
  type PlacementCandidateInput,
  type PlacementCandidates,
} from './candidates.ts';
import { buildDraftRequest as buildDraftRequestImpl, type BuildDraftRequestOptions } from './draft.ts';
import { sha256Hex as sha256HexImpl } from './hash.ts';
import { inspectPdf as inspectPdfImpl } from './inspect.ts';
import {
  createPacket as createPacketImpl,
  decodePacket as decodePacketImpl,
  encodePacket as encodePacketImpl,
} from './packet.ts';
import {
  requestSha256 as requestSha256Impl,
  resolveRequest as resolveRequestImpl,
  resolveRequestCollect as resolveRequestCollectImpl,
  type ResolveOptions,
  type ResolveReport,
  type ResolvedRequestWithWarnings,
} from './resolve.ts';
import { verifySignedPdf as verifySignedPdfImpl } from './verify.ts';
export { checkPasses } from './passes.ts';
export { decodeHandoff, readHandoffPdf, type HandoffContents } from './packet.ts';

export {
  MAX_PLACEMENT_CANDIDATES,
  findCandidatesInPdf,
  type FindPlacementCandidatesOptions,
  type PdfCandidates,
  type PlacementCandidate,
  type PlacementCandidateInput,
  type PlacementCandidates,
} from './candidates.ts';
export type { BuildDraftRequestOptions } from './draft.ts';
export {
  DEFAULT_PREVIEW_SCALE,
  FIELD_COLORS,
  MAX_PREVIEW_SCALE,
  MIN_PREVIEW_SCALE,
  PLACEMENT_CANDIDATE_COLOR,
  RULER_LEFT,
  RULER_TOP,
  checkPreviewOptions,
  renderPreview,
  type AnchorCandidates,
  type CanvasLike,
  type Context2d,
  type PdfjsRenderModule,
  type PreviewLayout,
  type PreviewOptions,
  type PreviewPage,
  type PreviewRenderer,
} from './preview.ts';
export {
  anchorCandidatesOf,
  nearestTextMatches,
  validateRequestAgainstPdf,
  type FieldReport,
  type NearestText,
  type ValidationIssue,
  type ValidationReport,
  type ValidationResult,
} from './validate.ts';
export { SignPdfError, type SignPdfErrorCode } from './errors.ts';
export { MAX_PACKET_CHARS, MAX_PDF_BYTES, MAX_SIGNATURE_IMAGE_SIDE } from './limits.ts';
export { configurePdfjs, type PdfjsLike } from './pdfjs.ts';
export type {
  AnchorCandidate,
  AnchorMatchRank,
  ResolveOptions,
  ResolveReport,
  ResolveWarning,
  ResolvedRequestWithWarnings,
} from './resolve.ts';
export {
  checkFieldValue,
  type CheckFieldValueOptions,
  type CheckableField,
  type FieldValueCheck,
} from './value-check.ts';

/** A run of text on a page, in the spec's top-left coordinate system. */
export interface TextItem extends Rect {
  text: string;
}

export interface AcroFieldInfo {
  /** Fully qualified name; use it in an `acroField` placement. */
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionList' | 'signature' | 'button' | 'other';
  /** First widget's position. Absent when the field has no visible widget. */
  rect?: Rect;
  value?: string | boolean;
  readOnly: boolean;
  /** The field's tooltip (TU), when it has one: a name for people. Untrusted document content. */
  tooltip?: string;
}

/** Per-page text and raster-image diagnosis. An image-only page cannot use anchors or text candidates. */
export interface InspectionPage extends PageInfo {
  textRunCount: number;
  hasText: boolean;
  imageOnly: boolean;
}

export interface InspectionWarning {
  code: 'image-only-page';
  hint: string;
}

/** A form field in summary mode: document-derived name, type and optional widget rectangle only. */
export type SummaryAcroField = Pick<AcroFieldInfo, 'name' | 'type' | 'rect'>;

/** One collapsed, lower-cased text line. Its text is untrusted document content. */
export interface SummaryTextLine {
  page: number;
  text: string;
}

export interface PdfInspection {
  sha256: string;
  pages: InspectionPage[];
  acroFields: AcroFieldInfo[];
  /** Page text with positions, for choosing anchors. Untrusted document content. */
  text: TextItem[];
  /** Horizontal lines drawn on the pages, as thin rects. Empty unless `rules` was asked for. */
  rules: Rect[];
  imageOnlyPages: number[];
  warnings: InspectionWarning[];
}

/** Compact first-pass inspection; lines and form field names are untrusted document content. */
export interface PdfInspectionSummary {
  sha256: string;
  pages: InspectionPage[];
  acroFields: SummaryAcroField[];
  textLines: SummaryTextLine[];
  imageOnlyPages: number[];
  warnings: InspectionWarning[];
}

export interface InspectOptions {
  /** Set false to omit text from the result. Diagnosis still reads text runs. Default true. */
  text?: boolean;
  /** Set true to also find drawn horizontal lines (for placement candidates). Needs text. Default false. */
  rules?: boolean;
  /** Summary collapses text into lines and omits text geometry and field values. Default full for compatibility. */
  detail?: 'summary' | 'full';
}

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array): Promise<string> {
  return sha256HexImpl(bytes);
}

/**
 * SHA-256 of a request's canonical JSON: the value a signed PDF's audit record
 * carries as `requestSha256`. Throws SignPdfError when the request is invalid.
 */
export function requestSha256(request: SignRequestInput): Promise<string> {
  return requestSha256Impl(request);
}

/** Describe a PDF: pages, existing form fields, and text with positions. */
export function inspectPdf(pdf: Uint8Array, options: InspectOptions & { detail: 'summary' }): Promise<PdfInspectionSummary>;
export function inspectPdf(pdf: Uint8Array, options?: InspectOptions & { detail?: 'full' }): Promise<PdfInspection>;
export function inspectPdf(
  pdf: Uint8Array,
  options?: InspectOptions,
): Promise<PdfInspection | PdfInspectionSummary> {
  if (options?.detail === 'summary') return inspectPdfImpl(pdf, { ...options, detail: 'summary' });
  return inspectPdfImpl(pdf, { ...options, detail: 'full' });
}

/**
 * Likely places for fields, from an inspection (`inspectPdf` with text): labels
 * ending in ":" ("Signature:"), underscore runs (with the short label before
 * them, as one candidate), and AcroForm fields with a visible widget. When a
 * widget overlaps a line (or the field after a label), only the widget is
 * listed.
 *
 * Each candidate has the rect of what was found, its text (untrusted document
 * content), and a suggested placement: an `anchor` on the label for labels and
 * labelled lines, a `rect` for a bare line or a label that is not a usable
 * anchor, and an `acroField` for widgets. `suggested.type` is set when the label
 * or form field makes the field type obvious. Results are in reading order and
 * capped at `MAX_PLACEMENT_CANDIDATES` (option `max`); `truncated` says so.
 */
export function findPlacementCandidates(
  inspection: PlacementCandidateInput,
  options?: FindPlacementCandidatesOptions,
): PlacementCandidates {
  return findPlacementCandidatesImpl(inspection, options);
}

/** Build a deterministic sign request from an inspection and its placement candidates. */
export function buildDraftRequest(
  inspection: PdfInspection,
  candidates: readonly PlacementCandidate[],
  options?: BuildDraftRequestOptions,
): SignRequestInput {
  return buildDraftRequestImpl(inspection, candidates, options);
}

/**
 * Validate a request against a PDF and turn every placement into a rectangle.
 * Throws SignPdfError when the hash does not match, an anchor or form field
 * cannot be found, a field falls outside its page, or a value written into the
 * request cannot be drawn in its field ('value-does-not-fit',
 * 'unsupported-characters').
 *
 * An anchor's text is matched in ranks: matches that are the whole text of a
 * run, then whole-word matches, then any substring; `occurrence` counts within
 * the best rank that has a match. When that rank has more than one match and
 * the request gives no `occurrence`, the result's `warnings` lists the
 * candidates ('anchor-ambiguous'). Pass the request as written: a request that
 * was already parsed has `occurrence` filled in and gets no such warning.
 */
export function resolveRequest(
  pdf: Uint8Array,
  request: SignRequestInput,
  options?: ResolveOptions,
): Promise<ResolvedRequestWithWarnings> {
  return resolveRequestImpl(pdf, request, options);
}

/**
 * Like `resolveRequest`, but checks every field instead of stopping at the
 * first bad one: field errors ('anchor-not-found', 'acro-field-not-found',
 * 'page-out-of-range', 'field-out-of-bounds', 'value-does-not-fit',
 * 'unsupported-characters') are returned in `errors`, one per field, in request
 * order. Problems with the request as a whole (invalid request, hash mismatch,
 * unreadable PDF) still throw SignPdfError, because no field can be checked.
 */
export function resolveRequestCollect(
  pdf: Uint8Array,
  request: SignRequestInput,
  options?: ResolveOptions,
): Promise<ResolveReport> {
  return resolveRequestCollectImpl(pdf, request, options);
}

/** Bundle the untouched PDF bytes and a validated request into one packet. */
export function createPacket(pdf: Uint8Array, request: SignRequestInput): Promise<Packet> {
  return createPacketImpl(pdf, request);
}

/** Serialize a packet to the text of a `.signpacket.json` file. */
export function encodePacket(packet: Packet): string {
  return encodePacketImpl(packet);
}

/** Parse and validate packet text; verifies the PDF bytes match the request hash. */
export function decodePacket(text: string): Promise<{ packet: Packet; pdf: Uint8Array }> {
  return decodePacketImpl(text);
}

export interface VerifyResult {
  /**
   * True when the PDF carries a well-formed sign-pdf audit record. This says
   * nothing about who wrote it: anyone can attach such a record to any PDF.
   */
  hasAuditRecord: boolean;
  /**
   * Whether the record and the document are proven to belong together and to
   * be unchanged. Always 'unverified' for now: the audit record is an
   * unauthenticated claim until signed PDFs carry a cryptographic signature.
   */
  integrity: 'unverified';
  /** The record's claims, when one was read. Not authenticated; see `integrity`. */
  audit?: AuditRecord;
  /** SHA-256 of the bytes given to verify. */
  sha256: string;
  /** Human-readable findings, such as a missing or malformed audit record. */
  problems: string[];
  /**
   * Present for a hand-off PDF: who has signed so far and who has not, by
   * signer id and name. Names are untrusted. A hand-off PDF is not final.
   */
  handoff?: {
    signed: { id: string; name: string }[];
    pending: { id: string; name?: string }[];
  };
}

/** Read the audit record back out of a PDF. Reports what the record claims; it proves nothing yet. */
export function verifySignedPdf(pdf: Uint8Array): Promise<VerifyResult> {
  return verifySignedPdfImpl(pdf);
}
