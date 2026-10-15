/**
 * The sign request format: the contract between every sign-pdf module.
 *
 * An agent (or a person using the prepare view) writes a SignRequest. It lists
 * the fields to put on an existing PDF, who fills each one, and which ones the
 * human must sign. Signature and initials fields can never carry a value: no
 * interface that accepts a SignRequest can be used to sign.
 *
 * Coordinates: PDF points (1/72 inch), origin at the TOP-LEFT of the page as
 * displayed (after the page's rotation and crop box are applied), y grows
 * downward. Pages are 1-based.
 */
// First: configures zod before any schema is built (see the file).
import './zod-config.ts';
import { z } from 'zod';

export * from './relay.ts';

export const SPEC_VERSION = 1 as const;

export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest');

export const FieldId = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
    'must start with a letter and contain only letters, digits, "_" or "-"',
  );

/** Id of one signer in a request with several `signers`. Same form as a field id. */
export const SignerId = FieldId;

/** Most signers one request can name. */
export const MAX_SIGNERS = 20;

/** One person who signs, in a request with several signers. */
export const Signer = z.strictObject({
  id: SignerId,
  /** Expected name, shown for confirmation. The human can correct it. */
  name: z.string().max(200).optional(),
});
export type Signer = z.infer<typeof Signer>;

const PageNumber = z.number().int().min(1);
const Size = z.number().positive();

/** A rectangle on one page, in the coordinate system described above. */
export const Rect = z.strictObject({
  page: PageNumber,
  x: z.number(),
  y: z.number(),
  width: Size,
  height: Size,
});
export type Rect = z.infer<typeof Rect>;

/** Explicit rectangle. Use when the position is already known. */
export const RectPlacement = z.strictObject({
  kind: z.literal('rect'),
  ...Rect.shape,
});

/**
 * Position relative to text already printed on the page, such as "Signature:".
 * This is the most reliable placement for an agent: no coordinates to guess.
 */
export const AnchorPlacement = z.strictObject({
  kind: z.literal('anchor'),
  /**
   * Text to find. Matching ignores case and collapses whitespace. Matches are
   * ranked: a run that is exactly this text, then whole words, then any
   * substring; only the best rank that has a match is used.
   */
  text: z.string().min(1).max(200),
  /** Limit the search to one page. Default: search all pages in order. */
  page: PageNumber.optional(),
  /** Which match of the best rank to use, in reading order (1 = first). */
  occurrence: z.number().int().min(1).default(1),
  /**
   * Where the field goes relative to the matched text:
   * - right: starts at the right edge of the text, vertically centred on it
   * - below / above: left-aligned with the text, directly under / over it
   * - over: top-left corner on the text's top-left corner
   */
  align: z.enum(['right', 'below', 'above', 'over']).default('right'),
  /** Extra offset in points, applied after `align`. */
  dx: z.number().default(0),
  dy: z.number().default(0),
  width: Size,
  height: Size,
});

/** Reuse an existing AcroForm field's position (and fill it where possible). */
export const AcroFieldPlacement = z.strictObject({
  kind: z.literal('acroField'),
  /** Fully qualified field name as reported by inspectPdf. */
  name: z.string().min(1),
});

export const Placement = z.discriminatedUnion('kind', [
  RectPlacement,
  AnchorPlacement,
  AcroFieldPlacement,
]);
export type Placement = z.infer<typeof Placement>;
export type PlacementInput = z.input<typeof Placement>;

const fieldBase = {
  id: FieldId,
  /** Shown to the human next to the field. Plain text. */
  label: z.string().max(200).optional(),
  placement: Placement,
  /**
   * The signer who fills this field, by id from the request's `signers`.
   * Every human field needs one when `signers` is given; agent fields never take one.
   */
  signerId: SignerId.optional(),
};

const fillable = {
  ...fieldBase,
  /** Who supplies the value. Agent-assigned fields must include `value`. */
  assignee: z.enum(['agent', 'human']),
  /** A required field blocks signing until it has a value; for a checkbox, until it is checked. */
  required: z.boolean().default(true),
};

const humanOnly = {
  ...fieldBase,
  assignee: z.literal('human'),
  required: z.boolean().default(true),
};

export const TextField = z.strictObject({
  ...fillable,
  type: z.literal('text'),
  value: z.string().max(5000).optional(),
  fontSize: z.number().min(4).max(72).optional(),
  multiline: z.boolean().optional(),
});

export const CheckboxField = z.strictObject({
  ...fillable,
  type: z.literal('checkbox'),
  value: z.boolean().optional(),
});

export const DateField = z.strictObject({
  ...fillable,
  type: z.literal('date'),
  /** ISO calendar date. A human date field without a value defaults to the signing day. */
  value: z.iso.date().optional(),
  fontSize: z.number().min(4).max(72).optional(),
});

/** No `value` key exists on purpose: only a human, in the sign view, supplies it. */
export const SignatureField = z.strictObject({
  ...humanOnly,
  type: z.literal('signature'),
});

export const InitialsField = z.strictObject({
  ...humanOnly,
  type: z.literal('initials'),
});

export const Field = z.discriminatedUnion('type', [
  TextField,
  CheckboxField,
  DateField,
  SignatureField,
  InitialsField,
]);
export type Field = z.infer<typeof Field>;
export type FieldInput = z.input<typeof Field>;
export type FieldType = Field['type'];

export const SIGNING_FIELD_TYPES = ['signature', 'initials'] as const;

export function isSigningField(
  field: Pick<Field, 'type'>,
): field is { type: (typeof SIGNING_FIELD_TYPES)[number] } {
  return field.type === 'signature' || field.type === 'initials';
}

export const DocumentRef = z.strictObject({
  /** File name for display and for naming the signed copy. */
  name: z.string().min(1).max(255),
  /** SHA-256 of the exact PDF bytes this request was written for. */
  sha256: Sha256Hex,
});

export const SignRequest = z
  .strictObject({
    version: z.literal(SPEC_VERSION),
    document: DocumentRef,
    /** Short title shown to the human. Plain text. */
    title: z.string().max(200).optional(),
    /** Note from whoever prepared the request. Shown as untrusted plain text. */
    note: z.string().max(2000).optional(),
    /** Expected signer, shown for confirmation. The human can correct it. Not used with `signers`. */
    signer: z.strictObject({ name: z.string().max(200).optional() }).optional(),
    /**
     * Several people who sign, in this order, one after another in the same
     * sign view. Each human field names its signer with `signerId`.
     */
    signers: z.array(Signer).min(1).max(MAX_SIGNERS).optional(),
    fields: z.array(Field).min(1).max(500),
  })
  .superRefine((request, ctx) => {
    const signerIds = new Set<string>();
    if (request.signers !== undefined) {
      if (request.signer !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['signer'], message: 'use "signers" or "signer", not both' });
      }
      request.signers.forEach((signer, index) => {
        if (signerIds.has(signer.id)) {
          ctx.addIssue({ code: 'custom', path: ['signers', index, 'id'], message: `duplicate signer id "${signer.id}"` });
        }
        signerIds.add(signer.id);
      });
    }
    const seen = new Set<string>();
    request.fields.forEach((field, index) => {
      if (request.signers === undefined) {
        if (field.signerId !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['fields', index, 'signerId'],
            message: 'signerId needs a "signers" list on the request',
          });
        }
      } else if (field.assignee === 'agent') {
        if (field.signerId !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['fields', index, 'signerId'],
            message: 'a field assigned to the agent takes no signerId',
          });
        }
      } else if (field.signerId === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'signerId'],
          message: 'a human field needs a signerId when the request has "signers"',
        });
      } else if (!signerIds.has(field.signerId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'signerId'],
          message: `signerId "${field.signerId}" is not in "signers"`,
        });
      }
      if (seen.has(field.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'id'],
          message: `duplicate field id "${field.id}"`,
        });
      }
      seen.add(field.id);
      if (field.assignee === 'agent' && !isSigningField(field) && field.value === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'value'],
          message: 'a field assigned to the agent must include a value',
        });
      }
    });
  });
/** A validated request with defaults applied. */
export type SignRequest = z.infer<typeof SignRequest>;
/** What a writer may supply: defaults are optional. */
export type SignRequestInput = z.input<typeof SignRequest>;

export function parseSignRequest(input: unknown): SignRequest {
  return SignRequest.parse(input);
}

export function safeParseSignRequest(input: unknown) {
  return SignRequest.safeParse(input);
}

/** JSON Schema for the request, for agents and tool definitions. */
export function signRequestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SignRequest, { io: 'input' }) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Resolved request: every placement turned into a rectangle on a known page.

export const PageInfo = z.strictObject({
  page: PageNumber,
  /** Displayed size in points, after rotation and crop box. */
  width: Size,
  height: Size,
});
export type PageInfo = z.infer<typeof PageInfo>;

export type ResolvedField = Field & {
  /** Where the field sits. The human can adjust this in the sign view. */
  rect: Rect;
};

export interface ResolvedRequest {
  request: SignRequest;
  pages: PageInfo[];
  fields: ResolvedField[];
}

// ---------------------------------------------------------------------------
// Audit record: written at signing and embedded in the signed PDF.

export const SignatureMethod = z.enum(['drawn', 'typed', 'uploaded']);
export type SignatureMethod = z.infer<typeof SignatureMethod>;

export const AuditField = z.strictObject({
  id: FieldId,
  type: z.enum(['text', 'checkbox', 'date', 'signature', 'initials']),
  /** Who the request assigned the field to. */
  assignee: z.enum(['agent', 'human']),
  /** Who supplied the final value. */
  filledBy: z.enum(['agent', 'human']),
  /** True when the human changed a value the agent had supplied. */
  changedByHuman: z.boolean(),
  /** True when the human moved or resized the field. */
  movedByHuman: z.boolean(),
  /**
   * True when the human reviewed a value the request supplied and kept it
   * unchanged. False for a request value nobody reviewed. Absent from records
   * written before this flag existed, so those records still parse.
   */
  confirmedByHuman: z.boolean().optional(),
  rect: Rect,
  /** Final value for text, checkbox and date fields. */
  value: z.union([z.string(), z.boolean()]).optional(),
  /** For signature and initials fields. */
  signatureMethod: SignatureMethod.optional(),
  /** SHA-256 of the signature image bytes. */
  signatureSha256: Sha256Hex.optional(),
  /**
   * In a record with `passes`: for a human field, the signer who owns it; for
   * an agent field, the signer whose pass changed, moved or confirmed it, if any.
   */
  signerId: SignerId.optional(),
});
export type AuditField = z.infer<typeof AuditField>;

const SignerName = z.strictObject({ name: z.string().min(1).max(200) });
const Consent = z.strictObject({
  /** The exact statement the human accepted. */
  text: z.string().min(1),
  acceptedAt: z.iso.datetime(),
});

/**
 * One signer's turn in a request with several signers. The passes form a hash
 * chain: the first pass's `previousSha256` is the record's `requestSha256`, and
 * each later one is the SHA-256 of the canonical JSON of the pass before it.
 */
export const AuditPass = z.strictObject({
  signerId: SignerId,
  signer: SignerName,
  consent: Consent,
  /** Local clock of the signing device; not a trusted timestamp. */
  signedAt: z.iso.datetime(),
  /** The fields this signer owns (their `signerId` in the request), in request order. */
  fieldIds: z.array(FieldId),
  previousSha256: Sha256Hex,
});
export type AuditPass = z.infer<typeof AuditPass>;

export const AuditRecord = z.strictObject({
  version: z.literal(SPEC_VERSION),
  app: z.strictObject({ name: z.string(), version: z.string() }),
  document: z.strictObject({
    name: z.string(),
    /** SHA-256 of the PDF as the request author prepared it. */
    originalSha256: Sha256Hex,
  }),
  /** SHA-256 of the canonical JSON of the request. */
  requestSha256: Sha256Hex,
  /** With `passes`, `signer`, `consent` and `signedAt` describe the last pass. */
  signer: SignerName,
  consent: Consent,
  /** Local clock of the signing device; not a trusted timestamp. */
  signedAt: z.iso.datetime(),
  fields: z.array(AuditField),
  /** One entry per signer, in signing order. Absent for a request without `signers`. */
  passes: z.array(AuditPass).min(1).max(MAX_SIGNERS).optional(),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

/** Name of the audit record attachment inside a signed PDF. */
export const AUDIT_ATTACHMENT_NAME = 'sign-pdf-audit.json';

// ---------------------------------------------------------------------------
// Packet: one file that carries the untouched PDF bytes plus the request.

export const PACKET_KIND = 'sign-pdf-packet' as const;
export const PACKET_FILE_SUFFIX = '.signpacket.json';

/** Largest signature or initials PNG, in bytes, that a packet pass can carry. */
export const MAX_SIGNATURE_PNG_BYTES = 4 * 1024 * 1024;

/** Name of the packet attachment inside a hand-off PDF. */
export const HANDOFF_ATTACHMENT_NAME = 'sign-pdf-handoff.json';
/** Suffix for a hand-off PDF's file name, in place of ".pdf". */
export const HANDOFF_FILE_SUFFIX = '-handoff.pdf';

/** A signature or initials image in a packet pass. */
export const PacketSignature = z.strictObject({
  /** PNG bytes, padded standard base64: no whitespace, no other alphabet. */
  pngBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_SIGNATURE_PNG_BYTES / 3) * 4, 'the signature image is too large')
    // A linear pattern plus a length check: a grouped pattern overflows the stack on megabytes.
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be padded standard base64')
    .refine((text) => text.length % 4 === 0, 'must be padded standard base64'),
  method: SignatureMethod,
});
export type PacketSignature = z.infer<typeof PacketSignature>;

/**
 * One finished signer's turn, carried in a hand-off to the next signer. It is
 * the JSON twin of core's `HumanInput`: the same keys, with each signature
 * image as base64. Nothing in it is final until the last signer signs.
 */
export const PacketPass = z.strictObject({
  signerId: SignerId,
  signerName: z.string().min(1).max(200),
  consent: Consent,
  /** Local clock of the signing device; not a trusted timestamp. */
  signedAt: z.iso.datetime(),
  /** Values the signer filled or changed, by field id. */
  values: z.record(FieldId, z.union([z.string().max(5000), z.boolean()])),
  /** Signature and initials images, by field id. */
  signatures: z.record(FieldId, PacketSignature),
  /** Fields the signer moved or resized, by field id. */
  rects: z.record(FieldId, Rect).optional(),
  /** Fields whose request value the signer reviewed and kept, by field id. */
  confirmed: z.record(FieldId, z.literal(true)).optional(),
});
export type PacketPass = z.infer<typeof PacketPass>;

export const Packet = z
  .strictObject({
    kind: z.literal(PACKET_KIND),
    version: z.literal(SPEC_VERSION),
    request: SignRequest,
    /** The original PDF, base64 (standard alphabet, padded). */
    pdfBase64: z.string().min(1),
    /**
     * The turns of the signers who already signed, in request order: a hand-off
     * to the next signer. Always fewer passes than signers.
     */
    passes: z.array(PacketPass).min(1).max(MAX_SIGNERS - 1).optional(),
  })
  .superRefine((packet, ctx) => {
    const passes = packet.passes;
    if (passes === undefined) return;
    const signers = packet.request.signers;
    if (signers === undefined) {
      ctx.addIssue({ code: 'custom', path: ['passes'], message: 'passes need a "signers" list on the request' });
      return;
    }
    if (passes.length >= signers.length) {
      ctx.addIssue({ code: 'custom', path: ['passes'], message: 'a hand-off has fewer passes than signers' });
    }
    const fields = new Map(packet.request.fields.map((field) => [field.id, field]));
    passes.forEach((pass, index) => {
      const at = (...path: PropertyKey[]) => ['passes', index, ...path];
      const expected = signers[index]?.id;
      if (pass.signerId !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: at('signerId'),
          message: `must be "${expected ?? '?'}": the passes follow the order of "signers"`,
        });
      }
      if (pass.signerName.trim() === '') ctx.addIssue({ code: 'custom', path: at('signerName'), message: 'is empty' });
      if (pass.consent.text.trim() === '') ctx.addIssue({ code: 'custom', path: at('consent', 'text'), message: 'is empty' });
      const groups = [
        ['values', pass.values],
        ['signatures', pass.signatures],
        ['rects', pass.rects ?? {}],
        ['confirmed', pass.confirmed ?? {}],
      ] as const;
      for (const [group, record] of groups) {
        for (const id of Object.keys(record)) {
          const issue = (message: string) => ctx.addIssue({ code: 'custom', path: at(group, id), message });
          const field = fields.get(id);
          if (field === undefined) {
            issue(`"${id}" is not a field in the request`);
            continue;
          }
          if (field.signerId !== undefined && field.signerId !== pass.signerId) {
            issue(`field "${id}" belongs to signer "${field.signerId}"`);
          } else if (field.signerId === undefined && index !== 0) {
            issue(`agent field "${id}" can change only in the first pass`);
          }
          if (group === 'signatures' && !isSigningField(field)) {
            issue(`field "${id}" is not a signature or initials field`);
          }
          if (group === 'values' && isSigningField(field)) {
            issue(`field "${id}" is a ${field.type} field and takes no value`);
          }
        }
      }
    });
  });
export type Packet = z.infer<typeof Packet>;
