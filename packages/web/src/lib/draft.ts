/**
 * A validated request turned back into the prepare draft, so an agent's
 * request (apply_request, the paste box, a #request= link) shows on the page
 * as ordinary fields the human can review, move and change.
 */
import type { ResolvedRequest } from '@sign-pdf/spec';
import { normalizeField, type DocumentDetails, type DraftField, type PrepareAction } from './fields.ts';

/** The `replace` action for a resolved request: its fields where they resolved, its details and signers. */
export function draftFromRequest(resolved: ResolvedRequest): Extract<PrepareAction, { type: 'replace' }> {
  const { request } = resolved;
  const fields = resolved.fields.map((field): DraftField => {
    const draft: DraftField = {
      id: field.id,
      type: field.type,
      label: field.label ?? '',
      assignee: field.assignee,
      required: field.required,
      rect: field.rect,
    };
    if ('value' in field && field.value !== undefined) draft.value = field.value;
    // Anchor and form-field placements are kept, so the exported request says the same.
    if (field.placement.kind === 'acroField') draft.acroField = field.placement.name;
    else if (field.placement.kind === 'anchor') draft.anchor = field.placement;
    if (field.signerId !== undefined) draft.signerId = field.signerId;
    return normalizeField(draft);
  });
  const details: DocumentDetails = {
    title: request.title ?? '',
    note: request.note ?? '',
    signerName: request.signer?.name ?? '',
  };
  return { type: 'replace', fields, details, signers: request.signers ?? [] };
}
