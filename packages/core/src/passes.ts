/**
 * The hash chain of signing passes in an audit record. Used by finalize, to
 * write the chain, and by verify, to recompute it. No signing code lives here.
 */
import type { AuditPass, AuditRecord } from '@sign-pdf/spec';
import { canonicalJson, sha256Hex, utf8 } from './hash.ts';

/** SHA-256 of a pass's canonical JSON: the next pass's `previousSha256`. */
export function auditPassSha256(pass: AuditPass): Promise<string> {
  return sha256Hex(utf8(canonicalJson(pass)));
}

/** Link passes into a chain that starts at the request hash. */
export async function chainPasses(
  requestSha256: string,
  passes: readonly Omit<AuditPass, 'previousSha256'>[],
): Promise<AuditPass[]> {
  const chained: AuditPass[] = [];
  let previousSha256 = requestSha256;
  for (const pass of passes) {
    const linked: AuditPass = { ...pass, previousSha256 };
    chained.push(linked);
    previousSha256 = await auditPassSha256(linked);
  }
  return chained;
}

/**
 * Findings about a record's passes: a broken chain, a signer with two passes,
 * a top-level signer that is not the last pass, a field listed twice or
 * unknown to the record, or a field whose signer the passes do not back.
 * Empty for a record without passes, and for a consistent one.
 */
export async function checkPasses(audit: AuditRecord): Promise<string[]> {
  const passes = audit.passes;
  if (passes === undefined) return [];
  const problems: string[] = [];
  let expected = audit.requestSha256;
  const seen = new Set<string>();
  for (const [index, pass] of passes.entries()) {
    if (pass.previousSha256 !== expected) {
      problems.push(`Pass ${index + 1} (signer "${pass.signerId}") does not follow from the one before it: the pass chain is broken.`);
    }
    if (seen.has(pass.signerId)) problems.push(`Signer "${pass.signerId}" has more than one pass.`);
    seen.add(pass.signerId);
    expected = await auditPassSha256(pass);
  }
  const last = passes.at(-1);
  if (
    last &&
    (last.signer.name !== audit.signer.name ||
      last.signedAt !== audit.signedAt ||
      last.consent.text !== audit.consent.text ||
      last.consent.acceptedAt !== audit.consent.acceptedAt)
  ) {
    problems.push('The signer, consent and signing time of the record do not match its last pass.');
  }
  const listed = new Map<string, string>();
  for (const pass of passes) {
    for (const id of pass.fieldIds) {
      if (listed.has(id)) problems.push(`Field "${id}" is listed in more than one pass.`);
      else listed.set(id, pass.signerId);
    }
  }
  const fieldIds = new Set(audit.fields.map((field) => field.id));
  for (const id of listed.keys()) {
    if (!fieldIds.has(id)) problems.push(`A pass lists the field "${id}", which the record does not have.`);
  }
  for (const field of audit.fields) {
    const owner = listed.get(field.id);
    if (owner !== undefined) {
      if (field.signerId !== owner) {
        problems.push(`Field "${field.id}" is not attributed to the same signer by the field and by the passes.`);
      }
    } else if (field.signerId !== undefined && (field.assignee !== 'agent' || !seen.has(field.signerId))) {
      // Only an agent field may name a signer outside the passes' lists: the one whose pass changed it.
      problems.push(`Field "${field.id}" names the signer "${field.signerId}", but no pass covers it.`);
    }
  }
  return problems;
}
