/**
 * The signing step. This is the only function that accepts signature images,
 * and only the web sign view imports it. The CLI and MCP server must not.
 */
import type { AuditRecord, Packet, PacketPass, Rect, ResolvedRequest, SignatureMethod } from '@sign-pdf/spec';
import { buildHandoffPdf as buildHandoffPdfImpl } from './handoff.ts';
import type { TextFontOptions } from './text-font.ts';
import { finalizeDocument as finalizeDocumentImpl } from './write.ts';

export interface HumanSignature {
  /** PNG image bytes of the signature or initials. */
  png: Uint8Array;
  method: SignatureMethod;
}

/**
 * One signer's pass in the sign view. A request without `signers` takes one
 * pass with no `signerId`. A request with `signers` takes one pass per signer,
 * in the request's order; each pass may fill, move or confirm only its own
 * signer's fields; only the first pass may change, move or confirm agent fields.
 */
export interface HumanInput {
  /** The signer of this pass, by id from the request's `signers`. Only for a request with `signers`. */
  signerId?: string;
  signerName: string;
  consent: { text: string; acceptedAt: string };
  /** Final values for text, checkbox and date fields the human filled or changed, by field id. */
  values: Record<string, string | boolean>;
  /** One entry per signature or initials field, by field id. */
  signatures: Record<string, HumanSignature>;
  /** Fields the human moved or resized, by field id. */
  rects?: Record<string, Rect>;
  /**
   * Fields whose request value the human reviewed and kept, by field id. The
   * audit record marks them `confirmedByHuman`; a request value not listed here
   * is recorded as unreviewed. Only fields with a request value can be listed.
   */
  confirmed?: Record<string, true>;
  /** ISO date-time of signing. Default: now, from the local clock. A human date field without a value gets this pass's day. */
  signedAt?: string;
}

/**
 * A fixed string that travels with the signing code. Any bundle that includes
 * this module contains this exact text, whatever its files are named, so a
 * build check can prove the CLI and MCP bundles do not carry the signing step.
 * It is defined here, and only here: nothing reachable from the index entry
 * may contain it.
 */
export const SIGNING_CODE_MARKER = 'sign-pdf:human-signing-code';

export type FinalizeOptions = TextFontOptions;

export interface FinalizeResult {
  /** The signed PDF: fields drawn, audit record embedded. */
  pdf: Uint8Array;
  audit: AuditRecord;
  /** SHA-256 of `pdf`. */
  sha256: string;
}

/**
 * Write every field value and signature into the PDF and embed the audit
 * record. Give one HumanInput, or for a request with `signers` an array with
 * one pass per signer in request order; the audit record then carries the
 * passes as a hash chain. Throws SignPdfError('missing-required-field') when a required field
 * has no visible value, signature, or (for a checkbox) tick, and
 * 'value-does-not-fit' or 'unsupported-characters' when a value cannot be
 * drawn inside its rectangle. Nothing is drawn outside a field's rectangle.
 */
export function finalizeDocument(
  pdf: Uint8Array,
  resolved: ResolvedRequest,
  input: HumanInput | readonly HumanInput[],
  options?: FinalizeOptions,
): Promise<FinalizeResult> {
  return finalizeDocumentImpl(pdf, resolved, input, options);
}

export type HandoffOptions = FinalizeOptions;

export interface HandoffResult {
  /**
   * The hand-off PDF: the original with the finished signers' fields drawn for
   * viewing only, and the packet attached. The pages carry no "not final"
   * mark: sign-pdf and its verify read the packet. It carries no audit record and is not a signed document.
   */
  pdf: Uint8Array;
  /** The attached packet: the original PDF, the request and the finished passes. */
  packet: Packet & { passes: PacketPass[] };
}

/**
 * Hand the document to the next signer on another device. Give the passes of
 * the signers who have signed: the first ones in the request's `signers`
 * order, never all of them. Each pass is checked as at signing, for its own
 * fields and the agent's, so a later `finalizeDocument` on the original with
 * these passes plus the remaining ones gives the same result as signing in one
 * session. Throws SignPdfError like `finalizeDocument`; 'invalid-request' also
 * when the passes are not such a prefix, or the request has no `signers`.
 *
 * `readHandoffPdf` in the main entry reads the result back.
 */
export function buildHandoffPdf(
  pdf: Uint8Array,
  resolved: ResolvedRequest,
  passes: readonly HumanInput[],
  options?: HandoffOptions,
): Promise<HandoffResult> {
  return buildHandoffPdfImpl(pdf, resolved, passes, options);
}

/**
 * Runtime use of the marker, so a bundler cannot drop the string: assigning a
 * property is a side effect that stays wherever `finalizeDocument` is kept.
 */
finalizeDocument.signingCodeMarker = SIGNING_CODE_MARKER;
