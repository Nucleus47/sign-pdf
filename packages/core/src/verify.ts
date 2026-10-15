import type { PDFDocument } from '@cantoo/pdf-lib';
import { AUDIT_ATTACHMENT_NAME, AuditRecord } from '@sign-pdf/spec';
import { AttachmentError, readNamedAttachments } from './attachments.ts';
import { errorMessage, formatIssues } from './errors.ts';
import { sha256Hex } from './hash.ts';
import type { VerifyResult } from './index.ts';
import { MAX_AUDIT_RECORD_BYTES, assertPdfSize } from './limits.ts';
import { loadPdf } from './load.ts';
import { decodeHandoff, handoffAttachments } from './packet.ts';
import { checkPasses } from './passes.ts';

/** Who has signed a hand-off PDF and who has not, or the problem that stops reading it. */
async function readHandoff(doc: PDFDocument): Promise<{ handoff?: VerifyResult['handoff']; problems: string[] }> {
  let found: Uint8Array[];
  try {
    found = handoffAttachments(doc);
  } catch (error) {
    return { problems: [errorMessage(error)] };
  }
  const [data] = found;
  if (data === undefined) return { problems: [] };
  if (found.length > 1) return { problems: [`The PDF carries ${found.length} hand-off attachments; it must carry one.`] };
  try {
    const { packet } = await decodeHandoff(data);
    const signers = packet.request.signers ?? [];
    const signed = packet.passes.map((pass) => ({ id: pass.signerId, name: pass.signerName }));
    const pending = signers.slice(signed.length).map((signer) => {
      const entry: { id: string; name?: string } = { id: signer.id };
      if (signer.name !== undefined) entry.name = signer.name;
      return entry;
    });
    const still = pending.map((signer) => `"${signer.id}"`).join(', ');
    return {
      handoff: { signed, pending },
      problems: [
        `Not final: this is a hand-off PDF. ${signed.length} of ${signers.length} signers have signed; still to sign: ${still}.`,
      ],
    };
  } catch (error) {
    return { problems: [`The PDF carries hand-off data that cannot be used: ${errorMessage(error)}`] };
  }
}

export async function verifySignedPdf(pdf: Uint8Array): Promise<VerifyResult> {
  assertPdfSize(pdf.length);
  const sha256 = await sha256Hex(pdf);
  const { doc } = await loadPdf(pdf);
  const { handoff, problems } = await readHandoff(doc);
  const unsigned = (problem: string): VerifyResult => {
    const result: VerifyResult = { hasAuditRecord: false, integrity: 'unverified', sha256, problems };
    if (handoff) result.handoff = handoff;
    else problems.push(problem);
    return result;
  };

  let candidates: Uint8Array[];
  try {
    candidates = readNamedAttachments(doc, AUDIT_ATTACHMENT_NAME, MAX_AUDIT_RECORD_BYTES, 'audit record');
  } catch (error) {
    const message =
      error instanceof AttachmentError ? error.message : `The PDF's attachments could not be read: ${errorMessage(error)}`;
    problems.push(message);
    return { hasAuditRecord: false, integrity: 'unverified', sha256, problems };
  }

  const data = candidates.at(-1);
  if (!data) return unsigned(`No ${AUDIT_ATTACHMENT_NAME} attachment: the PDF was not signed with sign-pdf.`);
  if (candidates.length > 1) {
    problems.push(`The PDF carries ${candidates.length} audit records; the last one was read.`);
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    problems.push('The audit record is not valid JSON.');
    return { hasAuditRecord: false, integrity: 'unverified', sha256, problems };
  }
  const parsed = AuditRecord.safeParse(json);
  if (!parsed.success) {
    problems.push(`The audit record is malformed: ${formatIssues(parsed.error.issues)}`);
    return { hasAuditRecord: false, integrity: 'unverified', sha256, problems };
  }
  problems.push(...(await checkPasses(parsed.data)));
  const result: VerifyResult = { hasAuditRecord: true, integrity: 'unverified', audit: parsed.data, sha256, problems };
  if (handoff) result.handoff = handoff;
  return result;
}
