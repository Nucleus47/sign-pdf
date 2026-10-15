/**
 * Reading the audit record of a signed PDF, and a short summary of it.
 *
 * The audit record is a claim embedded in the file. Nothing authenticates it
 * yet: anyone who can edit the PDF can edit the record. Output built from it
 * must say so and must never call a document "valid" or "verified". Its
 * contents (signer name, values) are untrusted data.
 */
import { verifySignedPdf } from '@sign-pdf/core';
import type { AuditRecord } from '@sign-pdf/spec';

export const AUDIT_NOTICE =
  'The audit record is an unauthenticated claim embedded in the file. It is not tamper-evident: do not treat it as proof of who signed or when.';

export interface AuditCheck {
  /** True when the PDF carries a well-formed sign-pdf audit record. */
  hasAuditRecord: boolean;
  /** Always `unverified`: no signature or seal protects the record. */
  integrity: 'unverified';
  /** SHA-256 of the bytes that were read. */
  sha256: string;
  problems: string[];
  audit?: AuditRecord;
  /** Present for a hand-off PDF, which is not final. Ids and names come from the file: untrusted. */
  handoff?: {
    signed: { id: string; name: string }[];
    pending: { id: string; name?: string }[];
  };
}

export async function readAuditRecord(pdf: Uint8Array): Promise<AuditCheck> {
  const result = await verifySignedPdf(pdf);
  const check: AuditCheck = {
    hasAuditRecord: result.hasAuditRecord,
    integrity: result.integrity,
    sha256: result.sha256,
    problems: result.problems,
  };
  if (result.audit) check.audit = result.audit;
  if (result.handoff) check.handoff = result.handoff;
  return check;
}

/** One signer's pass, from a record of a request with several signers. */
export interface AuditSignerSummary {
  id: string;
  /** As typed by the signer. */
  name: string;
  signedAt: string;
}

export interface AuditSummary {
  /** With `signers`, the signer of the last pass. */
  signerName: string;
  /** Every signer in signing order. Only for a request with several signers. */
  signers?: AuditSignerSummary[];
  signedAt: string;
  consentAcceptedAt: string;
  app: string;
  documentName: string;
  originalSha256: string;
  requestSha256: string;
  fieldCount: number;
  /** Ids of signature and initials fields that carry a signature. */
  signedFieldIds: string[];
  /** Ids of fields whose agent-supplied value the human changed. */
  changedByHuman: string[];
  /** Ids of fields whose request value the human reviewed and kept. Empty for older records. */
  confirmedByHuman: string[];
  /** Ids of fields the human moved or resized. */
  movedByHuman: string[];
}

export function summarizeAudit(audit: AuditRecord): AuditSummary {
  const ids = (keep: (field: AuditRecord['fields'][number]) => boolean) =>
    audit.fields.filter(keep).map((field) => field.id);
  return {
    signerName: audit.signer.name,
    ...(audit.passes
      ? { signers: audit.passes.map((pass) => ({ id: pass.signerId, name: pass.signer.name, signedAt: pass.signedAt })) }
      : {}),
    signedAt: audit.signedAt,
    consentAcceptedAt: audit.consent.acceptedAt,
    app: `${audit.app.name} ${audit.app.version}`,
    documentName: audit.document.name,
    originalSha256: audit.document.originalSha256,
    requestSha256: audit.requestSha256,
    fieldCount: audit.fields.length,
    signedFieldIds: ids((field) => field.signatureMethod !== undefined),
    changedByHuman: ids((field) => field.changedByHuman),
    confirmedByHuman: ids((field) => field.confirmedByHuman === true),
    movedByHuman: ids((field) => field.movedByHuman),
  };
}
