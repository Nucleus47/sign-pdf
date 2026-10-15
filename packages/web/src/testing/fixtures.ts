/** Synthetic fixtures and a fake core for unit and component tests. */
import type { AuditRecord, Rect, ResolvedField, ResolvedRequest, SignRequest } from '@sign-pdf/spec';
import type { CoreApi } from '../lib/core.ts';

export const SHA = 'a'.repeat(64);
const at = (y: number, width = 180, height = 18): Rect => ({ page: 1, x: 72, y, width, height });

export const FIELDS: ResolvedField[] = [
  {
    id: 'company',
    type: 'text',
    label: 'Company name',
    assignee: 'agent',
    required: true,
    value: 'Example Company Ltd',
    placement: { kind: 'rect', ...at(100) },
    rect: at(100),
  },
  {
    id: 'title',
    type: 'text',
    label: 'Your job title',
    assignee: 'human',
    required: true,
    placement: { kind: 'rect', ...at(130) },
    rect: at(130),
  },
  {
    id: 'nickname',
    type: 'text',
    assignee: 'human',
    required: false,
    placement: { kind: 'rect', ...at(160) },
    rect: at(160),
  },
  {
    id: 'agree',
    type: 'checkbox',
    label: 'I have authority to sign',
    assignee: 'human',
    required: true,
    placement: { kind: 'rect', ...at(190, 14, 14) },
    rect: at(190, 14, 14),
  },
  {
    id: 'signed_on',
    type: 'date',
    label: 'Date',
    assignee: 'human',
    required: true,
    placement: { kind: 'rect', ...at(220, 90) },
    rect: at(220, 90),
  },
  {
    id: 'signature',
    type: 'signature',
    label: 'Signature',
    assignee: 'human',
    required: true,
    placement: { kind: 'rect', ...at(260, 180, 44) },
    rect: at(260, 180, 44),
  },
];

export function makeResolved(fields: ResolvedField[] = FIELDS, extra: Partial<SignRequest> = {}): ResolvedRequest {
  const request: SignRequest = {
    version: 1,
    document: { name: 'agreement.pdf', sha256: SHA },
    fields: fields.map(({ rect: _rect, ...field }) => field),
    ...extra,
  };
  return { request, pages: [{ page: 1, width: 612, height: 792 }], fields };
}

export function makeAudit(): AuditRecord {
  return {
    version: 1,
    app: { name: 'sign-pdf', version: 'test' },
    document: { name: 'agreement.pdf', originalSha256: SHA },
    requestSha256: SHA,
    signer: { name: 'Test Signer' },
    consent: { text: 'statement', acceptedAt: '2026-01-02T03:04:05.000Z' },
    signedAt: '2026-01-02T03:04:05.000Z',
    fields: [],
  };
}

const notUsed = (name: string) => () => Promise.reject(new Error(`fake core: ${name} was not expected`));

/** A core double: every call fails unless the test supplies it. */
export function fakeCore(overrides: Partial<CoreApi>): CoreApi {
  return {
    sha256Hex: notUsed('sha256Hex'),
    inspectPdf: notUsed('inspectPdf'),
    inspectPdfWith: notUsed('inspectPdfWith'),
    validateRequest: notUsed('validateRequest'),
    findCandidatesInPdf: notUsed('findCandidatesInPdf'),
    renderPreview: notUsed('renderPreview'),
    findPlacementCandidates: () => Promise.resolve({ candidates: [], truncated: false, total: 0 }),
    resolveRequest: notUsed('resolveRequest'),
    createPacket: notUsed('createPacket'),
    encodePacket: notUsed('encodePacket'),
    decodePacket: notUsed('decodePacket'),
    verifySignedPdf: notUsed('verifySignedPdf'),
    checkFieldValue: (_field, _rect, value) => Promise.resolve({ ok: true, value }),
    limits: () => Promise.resolve({ maxPdfBytes: 1024, maxPacketChars: 2048, maxSignatureImageSide: 4096 }),
    readHandoffPdf: () => Promise.resolve(null),
    decodeHandoff: notUsed('decodeHandoff'),
    buildHandoffPdf: notUsed('buildHandoffPdf'),
    finalizeDocument: notUsed('finalizeDocument'),
    ...overrides,
  };
}

/** A tiny valid-looking PNG header; tests never decode it. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Two signers in turn: an agent field, then each signer's own fields. */
export const TWO_SIGNER_FIELDS: ResolvedField[] = [
  FIELDS[0] as ResolvedField,
  {
    id: 'sigA',
    type: 'signature',
    label: 'First signature',
    assignee: 'human',
    signerId: 'a',
    required: true,
    placement: { kind: 'rect', ...at(300, 180, 44) },
    rect: at(300, 180, 44),
  },
  {
    id: 'dateA',
    type: 'date',
    label: 'First date',
    assignee: 'human',
    signerId: 'a',
    required: true,
    placement: { kind: 'rect', ...at(350, 90) },
    rect: at(350, 90),
  },
  {
    id: 'sigB',
    type: 'signature',
    label: 'Second signature',
    assignee: 'human',
    signerId: 'b',
    required: true,
    placement: { kind: 'rect', ...at(400, 180, 44) },
    rect: at(400, 180, 44),
  },
  {
    id: 'noteB',
    type: 'text',
    label: 'Second note',
    assignee: 'human',
    signerId: 'b',
    required: false,
    placement: { kind: 'rect', ...at(450) },
    rect: at(450),
  },
];

export const TWO_SIGNERS = [
  { id: 'a', name: 'Signer One' },
  { id: 'b', name: 'Signer Two' },
];

export function makeTwoSignerResolved(): ResolvedRequest {
  return makeResolved(TWO_SIGNER_FIELDS, { signers: TWO_SIGNERS });
}
