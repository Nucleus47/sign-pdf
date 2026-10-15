/**
 * The only module in the web app that touches @sign-pdf/core.
 *
 * Every view calls `core.*`; tests swap the implementation with `setCore`.
 * The real modules are imported on demand so the PDF libraries stay out of
 * the first-paint bundle.
 */
import type {
  CheckableField,
  HandoffContents,
  PlacementCandidates,
  FieldValueCheck,
  InspectOptions,
  PdfCandidates,
  PdfInspection,
  PdfInspectionSummary,
  PreviewLayout,
  PreviewOptions,
  PreviewPage,
  SignPdfErrorCode,
  ValidationResult,
  VerifyResult,
} from '@sign-pdf/core';
import type { FinalizeResult, HandoffOptions, HandoffResult, HumanInput } from '@sign-pdf/core/sign';
import type { Packet, ResolvedRequest, SignRequestInput } from '@sign-pdf/spec';
import { browserPreviewRenderer } from '../agent/previewRenderer.ts';
import { loadPdfjs } from '../pdf/pdfjs.ts';
import { loadCode } from './release.ts';

export type {
  PdfInspection,
  VerifyResult,
  FinalizeResult,
  HumanInput,
  SignPdfErrorCode,
  FieldValueCheck,
  CheckableField,
  HandoffContents,
  HandoffResult,
  PdfCandidates,
  PdfInspectionSummary,
  PreviewPage,
  ValidationResult,
};

/** Size limits the core enforces, so the app can refuse a file before reading it. */
export interface CoreLimits {
  maxPdfBytes: number;
  maxPacketChars: number;
  maxSignatureImageSide: number;
}
export type { AcroFieldInfo, TextItem, PlacementCandidate, PlacementCandidates } from '@sign-pdf/core';
export type { HumanSignature } from '@sign-pdf/core/sign';

export interface CoreApi {
  sha256Hex(bytes: Uint8Array): Promise<string>;
  inspectPdf(pdf: Uint8Array): Promise<PdfInspection>;
  /** The browser agent's inspect_pdf: full or summary, with or without text. */
  inspectPdfWith(pdf: Uint8Array, options: InspectOptions): Promise<PdfInspection | PdfInspectionSummary>;
  /** Check a request (any JSON) against a PDF: every problem, not just the first. */
  validateRequest(pdf: Uint8Array, request: unknown): Promise<ValidationResult>;
  /** Inspect a PDF and find its placement candidates. */
  findCandidatesInPdf(pdf: Uint8Array, options?: { max?: number }): Promise<PdfCandidates>;
  /** PNG previews of the layout for an agent, drawn with the browser's canvas. Never shown on the page. */
  renderPreview(pdf: Uint8Array, layout: PreviewLayout, options: PreviewOptions): Promise<PreviewPage[]>;
  /** Likely places for fields, from an inspection with text. */
  findPlacementCandidates(inspection: PdfInspection): Promise<PlacementCandidates>;
  resolveRequest(pdf: Uint8Array, request: SignRequestInput): Promise<ResolvedRequest>;
  createPacket(pdf: Uint8Array, request: SignRequestInput): Promise<Packet>;
  encodePacket(packet: Packet): Promise<string>;
  decodePacket(text: string): Promise<{ packet: Packet; pdf: Uint8Array }>;
  verifySignedPdf(pdf: Uint8Array): Promise<VerifyResult>;
  /** Can this value be drawn in a box of this size? The same rules finalizeDocument applies. */
  checkFieldValue(
    field: CheckableField,
    rect: { width: number; height: number },
    value: string | boolean,
  ): Promise<FieldValueCheck>;
  limits(): Promise<CoreLimits>;
  /** The packet a hand-off PDF carries, or null for any other PDF. Throws 'invalid-handoff' when it is damaged. */
  readHandoffPdf(pdf: Uint8Array): Promise<HandoffContents | null>;
  /** The contents of hand-off data (packet JSON bytes, as an emailed document carries). Throws 'invalid-handoff'. */
  decodeHandoff(data: Uint8Array): Promise<HandoffContents>;
  /** The PDF for the next signer on another device: the finished passes drawn for viewing, the packet attached. */
  buildHandoffPdf(
    pdf: Uint8Array,
    resolved: ResolvedRequest,
    passes: readonly HumanInput[],
    options?: HandoffOptions,
  ): Promise<HandoffResult>;
  /** The signing step. Only the sign view calls this. */
  finalizeDocument(
    pdf: Uint8Array,
    resolved: ResolvedRequest,
    /** One input, or one per signer in request order for a request with signers. */
    input: HumanInput | readonly HumanInput[],
  ): Promise<FinalizeResult>;
}

type PrepareModule = typeof import('@sign-pdf/core');
let prepareModule: Promise<PrepareModule> | undefined;

/**
 * Load the core together with the app's own pdf.js (worker already set) and
 * hand that pdf.js to the core, so the page and the core share one copy and
 * one worker. Without this the core would fall back to its Node build.
 */
function prepare(): Promise<PrepareModule> {
  prepareModule ??= (async () => {
    const [module, pdfjs] = await Promise.all([loadCode(() => import('@sign-pdf/core')), loadPdfjs()]);
    module.configurePdfjs(pdfjs);
    return module;
  })();
  return prepareModule;
}

const sign = () => loadCode(() => import('@sign-pdf/core/sign'));

const realCore: CoreApi = {
  sha256Hex: async (bytes) => (await prepare()).sha256Hex(bytes),
  inspectPdf: async (pdf) => (await prepare()).inspectPdf(pdf),
  inspectPdfWith: async (pdf, options) => {
    const module = await prepare();
    return options.detail === 'summary'
      ? module.inspectPdf(pdf, { ...options, detail: 'summary' })
      : module.inspectPdf(pdf, { ...options, detail: 'full' });
  },
  validateRequest: async (pdf, request) => (await prepare()).validateRequestAgainstPdf(pdf, request),
  findCandidatesInPdf: async (pdf, options) => (await prepare()).findCandidatesInPdf(pdf, options),
  renderPreview: async (pdf, layout, options) => {
    const [module, renderer] = await Promise.all([prepare(), browserPreviewRenderer()]);
    return module.renderPreview(pdf, layout, renderer, options);
  },
  findPlacementCandidates: async (inspection) => (await prepare()).findPlacementCandidates(inspection),
  resolveRequest: async (pdf, request) => (await prepare()).resolveRequest(pdf, request),
  createPacket: async (pdf, request) => (await prepare()).createPacket(pdf, request),
  encodePacket: async (packet) => (await prepare()).encodePacket(packet),
  decodePacket: async (text) => (await prepare()).decodePacket(text),
  verifySignedPdf: async (pdf) => (await prepare()).verifySignedPdf(pdf),
  checkFieldValue: async (field, rect, value) => (await prepare()).checkFieldValue(field, rect, value),
  limits: async () => {
    const module = await prepare();
    return {
      maxPdfBytes: module.MAX_PDF_BYTES,
      maxPacketChars: module.MAX_PACKET_CHARS,
      maxSignatureImageSide: module.MAX_SIGNATURE_IMAGE_SIDE,
    };
  },
  readHandoffPdf: async (pdf) => (await prepare()).readHandoffPdf(pdf),
  decodeHandoff: async (data) => (await prepare()).decodeHandoff(data),
  buildHandoffPdf: async (pdf, resolved, passes, options) =>
    (await sign()).buildHandoffPdf(pdf, resolved, passes, options),
  finalizeDocument: async (pdf, resolved, input) =>
    (await sign()).finalizeDocument(pdf, resolved, input),
};

let active: CoreApi = realCore;

/** Replace the implementation (tests). Returns a function that restores the previous one. */
export function setCore(replacement: CoreApi): () => void {
  const previous = active;
  active = replacement;
  return () => {
    active = previous;
  };
}

/**
 * PDF bytes are copied on the way in: a PDF library may transfer or mutate the
 * buffer it is given, and the app keeps using its own copy.
 */
const copy = (bytes: Uint8Array): Uint8Array => bytes.slice();

export const core: CoreApi = {
  sha256Hex: (bytes) => active.sha256Hex(copy(bytes)),
  inspectPdf: (pdf) => active.inspectPdf(copy(pdf)),
  inspectPdfWith: (pdf, options) => active.inspectPdfWith(copy(pdf), options),
  validateRequest: (pdf, request) => active.validateRequest(copy(pdf), request),
  findCandidatesInPdf: (pdf, options) => active.findCandidatesInPdf(copy(pdf), options),
  renderPreview: (pdf, layout, options) => active.renderPreview(copy(pdf), layout, options),
  findPlacementCandidates: (inspection) => active.findPlacementCandidates(inspection),
  resolveRequest: (pdf, request) => active.resolveRequest(copy(pdf), request),
  createPacket: (pdf, request) => active.createPacket(copy(pdf), request),
  encodePacket: (packet) => active.encodePacket(packet),
  decodePacket: (text) => active.decodePacket(text),
  verifySignedPdf: (pdf) => active.verifySignedPdf(copy(pdf)),
  checkFieldValue: (field, rect, value) => active.checkFieldValue(field, rect, value),
  limits: () => active.limits(),
  readHandoffPdf: (pdf) => active.readHandoffPdf(copy(pdf)),
  decodeHandoff: (data) => active.decodeHandoff(copy(data)),
  buildHandoffPdf: (pdf, resolved, passes, options) => active.buildHandoffPdf(copy(pdf), resolved, passes, options),
  finalizeDocument: (pdf, resolved, input) => active.finalizeDocument(copy(pdf), resolved, input),
};

/** Shape of a SignPdfError, matched by duck typing so a fake core can throw one too. */
export type ProblemCode = SignPdfErrorCode | 'unknown';

export interface CoreProblem {
  code: ProblemCode;
  message: string;
  fieldId?: string;
  /** Where it was thrown, for the error report (lib/errorReport.ts). */
  stack?: string;
}

const KNOWN_CODES: ReadonlySet<string> = new Set<ProblemCode>([
  'invalid-request',
  'invalid-pdf',
  'encrypted-pdf',
  'hash-mismatch',
  'anchor-not-found',
  'acro-field-not-found',
  'page-out-of-range',
  'field-out-of-bounds',
  'invalid-packet',
  'invalid-handoff',
  'missing-required-field',
  'not-signed',
  'value-does-not-fit',
  'unsupported-characters',
  'invalid-argument',
]);

export function toCoreProblem(error: unknown): CoreProblem {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown; fieldId?: unknown; stack?: unknown };
    const message = typeof candidate.message === 'string' ? candidate.message : String(error);
    const problem: CoreProblem = { code: 'unknown', message };
    if (typeof candidate.stack === 'string') problem.stack = candidate.stack;
    if (typeof candidate.code === 'string' && KNOWN_CODES.has(candidate.code)) {
      problem.code = candidate.code as ProblemCode;
      if (typeof candidate.fieldId === 'string') problem.fieldId = candidate.fieldId;
    }
    return problem;
  }
  return { code: 'unknown', message: String(error) };
}

/** What went wrong, for a person. The technical message is shown separately as detail. */
export function explainProblem(problem: CoreProblem): string {
  switch (problem.code) {
    case 'invalid-request':
      return 'The sign request is not valid.';
    case 'invalid-pdf':
      return 'This file could not be read as a PDF.';
    case 'encrypted-pdf':
      return 'This PDF is password-protected. Remove the protection, then open it again.';
    case 'hash-mismatch':
      return 'The request was written for a different version of this PDF. Ask the preparer for the matching file.';
    case 'anchor-not-found':
      return 'The text this field should sit next to was not found in the document.';
    case 'acro-field-not-found':
      return 'The form field this entry refers to does not exist in the document.';
    case 'page-out-of-range':
      return 'This field is on a page the document does not have.';
    case 'field-out-of-bounds':
      return 'This field falls outside its page.';
    case 'invalid-packet':
      return 'This packet file is damaged or is not a sign-pdf packet.';
    case 'invalid-handoff':
      return 'This hand-off PDF is damaged or was changed. Ask the signer who sent it for a new copy.';
    case 'missing-required-field':
      return 'A required field has no value yet.';
    case 'value-does-not-fit':
      return 'The text is too long for its box. Shorten the text, or make the box larger on the page.';
    case 'unsupported-characters':
      return 'The text has characters that cannot be printed (only Latin, Greek and Cyrillic letters can). Remove or replace them.';
    case 'not-signed':
      return 'This PDF has no sign-pdf audit record.';
    default:
      return 'Something went wrong while reading the document.';
  }
}
