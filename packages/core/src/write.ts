/**
 * Implementation of the signing step. Reached only through `./sign.ts`.
 */
import * as fontkit from '@cantoo/fontkit';
import {
  PDFCheckBox,
  PDFDict,
  PDFName,
  PDFRef,
  PDFTextField,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  translate,
  type PDFDocument,
  type PDFFont,
  type PDFForm,
  type PDFImage,
} from '@cantoo/pdf-lib';
import {
  AUDIT_ATTACHMENT_NAME,
  AuditRecord,
  MAX_SIGNERS,
  Rect,
  SPEC_VERSION,
  SignatureMethod,
  isSigningField,
  type AuditField,
  type AuditPass,
  type Field,
  type ResolvedRequest,
} from '@sign-pdf/spec';
import { z } from 'zod';
import { drawCheckMark, drawInRect, drawSignature, drawTextLayout } from './draw.ts';
import { SignPdfError, errorMessage, formatIssues } from './errors.ts';
import type { PageGeometry } from './geometry.ts';
import { sha256Hex, utf8 } from './hash.ts';
import { hasAcroForm, widgetPageIndex } from './inspect.ts';
import { assertPdfSize } from './limits.ts';
import { loadPdf } from './load.ts';
import { chainPasses } from './passes.ts';
import { checkSignaturePng } from './png.ts';
import { assertDocumentHash, assertRectOnPage, requestSha256, validateRequest } from './resolve.ts';
import type { FinalizeOptions, FinalizeResult, HumanInput, HumanSignature } from './sign.ts';
import { loadTextFont, type TextFont } from './text-font.ts';
import { isBlankText, type TextLayout } from './text-layout.ts';
import { assertFieldValue, cleanFieldText, layoutFieldText } from './value-check.ts';
import { APP_NAME, CORE_VERSION } from './version.ts';

/** What `finalizeDocument` accepts from the sign view. Everything else is rejected. */
export const HumanInputSchema = z.strictObject({
  signerId: z.string().optional(),
  signerName: z.string().max(200),
  consent: z.strictObject({ text: z.string(), acceptedAt: z.iso.datetime() }),
  values: z.record(z.string(), z.union([z.string(), z.boolean()])),
  signatures: z.record(
    z.string(),
    z.strictObject({
      png: z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'must be a Uint8Array of PNG bytes'),
      method: SignatureMethod,
    }),
  ),
  rects: z.record(z.string(), Rect).optional(),
  confirmed: z.record(z.string(), z.literal(true)).optional(),
  signedAt: z.iso.datetime().optional(),
});

export interface PlannedField {
  field: Field;
  rect: Rect;
  /** Non-empty text to draw, already cleaned and laid out. */
  text?: { value: string; layout: TextLayout };
  checked?: boolean;
  signature?: HumanSignature;
  /** The real form field to fill and flatten. */
  fill?: PDFTextField | PDFCheckBox;
  /** A real form field that the drawn value replaces. */
  replace?: PDFTextField | PDFCheckBox;
  audit: AuditField;
}

function invalid(message: string, fieldId?: string): SignPdfError {
  return new SignPdfError('invalid-request', message, fieldId);
}

const sameRect = (p: Rect, q: Rect): boolean =>
  p.page === q.page && p.x === q.x && p.y === q.y && p.width === q.width && p.height === q.height;

function assertKnownIds(kind: string, record: Record<string, unknown> | undefined, ids: Set<string>): void {
  for (const id of Object.keys(record ?? {})) {
    if (!ids.has(id)) throw invalid(`${kind} was given for "${id}", which is not a field in the request.`);
  }
}

export type ParsedInput = z.infer<typeof HumanInputSchema>;

/** What the passes supplied, merged into one set of records by field id. */
type FieldInput = Pick<ParsedInput, 'values' | 'signatures' | 'rects' | 'confirmed'>;

/** The checked passes, and which pass each field belongs to. */
export interface MergedPasses {
  input: FieldInput;
  passes: (ParsedInput & { signerName: string; signedAt: string })[];
  /** Index into `passes` of the pass that owns or reviewed a field. Fields absent here belong to no pass. */
  passOf: Map<string, number>;
}

/**
 * Check the passes against the request and merge them. One pass without a
 * signer id for a request without `signers`; otherwise one pass per signer in
 * request order, each touching only its own fields; only the first pass can
 * touch agent fields.
 *
 * With `complete: false`, the passes are a hand-off: the first one or more
 * signers in request order, never all of them. A request without `signers`
 * cannot be handed off.
 */
export function checkPassPrefix(
  request: ResolvedRequest['request'],
  given: readonly ParsedInput[],
  now: string,
  { complete }: { complete: boolean },
): MergedPasses {
  const passes = given.map((pass) => {
    const signerName = pass.signerName.trim();
    if (signerName === '') throw invalid('The signer name is empty.');
    if (pass.consent.text.trim() === '') throw invalid('The consent text is empty.');
    return { ...pass, signerName, signedAt: pass.signedAt ?? now };
  });
  const signers = request.signers;
  if (signers === undefined) {
    if (!complete) throw invalid('This request has one signer: there is no next signer to hand it to.');
    const [only] = passes;
    if (!only || passes.length !== 1) throw invalid('This request has one signer: give exactly one signing input.');
    if (only.signerId !== undefined) throw invalid('This request has no "signers": the signing input takes no signerId.');
    return { input: only, passes, passOf: new Map() };
  }
  const outOfOrder = passes.some((pass, index) => pass.signerId !== signers[index]?.id);
  const expected = signers.map((signer) => signer.id).join(', ');
  if (complete && (passes.length !== signers.length || outOfOrder)) {
    throw invalid(`This request needs one signing pass per signer, in this order: ${expected}.`);
  }
  if (!complete && (passes.length === 0 || passes.length >= signers.length || outOfOrder)) {
    throw invalid(
      `A hand-off needs the passes of the first signers, in this order, with at least one signer still to sign: ${expected}.`,
    );
  }

  const ids = new Set(request.fields.map((field) => field.id));
  const byId = new Map(request.fields.map((field) => [field.id, field]));
  const passOf = new Map<string, number>();
  for (const field of request.fields) {
    if (field.signerId !== undefined) passOf.set(field.id, signers.findIndex((signer) => signer.id === field.signerId));
  }
  const input: Required<FieldInput> = { values: {}, signatures: {}, rects: {}, confirmed: {} };
  passes.forEach((pass, index) => {
    assertKnownIds('A value', pass.values, ids);
    assertKnownIds('A signature', pass.signatures, ids);
    assertKnownIds('A position', pass.rects, ids);
    assertKnownIds('A confirmation', pass.confirmed, ids);
    const claim = (id: string) => {
      const field = byId.get(id);
      if (field?.signerId !== undefined && field.signerId !== pass.signerId) {
        throw invalid(`Field "${id}" belongs to signer "${field.signerId}": the pass of "${pass.signerId}" cannot change it.`, id);
      }
      if (field?.signerId === undefined && index !== 0) {
        throw invalid(`Field "${id}" is an agent field: only the first signing pass can change or confirm it.`, id);
      }
      const owner = passOf.get(id);
      if (owner !== undefined && owner !== index) {
        throw invalid(`Field "${id}" was changed or confirmed in more than one signing pass.`, id);
      }
      passOf.set(id, index);
    };
    for (const [id, value] of Object.entries(pass.values)) {
      claim(id);
      input.values[id] = value;
    }
    for (const [id, signature] of Object.entries(pass.signatures)) {
      claim(id);
      input.signatures[id] = signature;
    }
    for (const [id, rect] of Object.entries(pass.rects ?? {})) {
      claim(id);
      input.rects[id] = rect;
    }
    for (const id of Object.keys(pass.confirmed ?? {})) {
      claim(id);
      input.confirmed[id] = true;
    }
  });
  return { input, passes, passOf };
}

export async function planFields(
  resolved: ResolvedRequest,
  input: FieldInput,
  signedAtOf: (fieldId: string) => string,
  signerIdOf: (fieldId: string) => string | undefined,
  pages: readonly PageGeometry[],
  form: PDFForm | undefined,
  font: TextFont,
  /** Plan only the fields this accepts. Default: every field. */
  include: (field: Field) => boolean = () => true,
): Promise<PlannedField[]> {
  const request = resolved.request;
  const ids = new Set(request.fields.map((field) => field.id));
  assertKnownIds('A value', input.values, ids);
  assertKnownIds('A signature', input.signatures, ids);
  assertKnownIds('A position', input.rects, ids);
  assertKnownIds('A confirmation', input.confirmed, ids);
  const resolvedFields = Array.isArray(resolved.fields) ? resolved.fields : [];

  const usedAcroNames = new Set<string>();
  const planned: PlannedField[] = [];
  for (const field of request.fields) {
    if (!include(field)) continue;
    const id = field.id;
    const resolvedRect = Rect.safeParse(resolvedFields.find((candidate) => candidate?.id === id)?.rect);
    if (!resolvedRect.success) throw invalid(`Field "${id}" has no resolved position.`, id);

    let rect = resolvedRect.data;
    let moved = false;
    const humanRect = input.rects && Object.hasOwn(input.rects, id) ? input.rects[id] : undefined;
    if (humanRect) {
      moved = !sameRect(humanRect, rect);
      rect = humanRect;
    }
    assertRectOnPage(rect, pages, id);

    const audit: AuditField = {
      id,
      type: field.type,
      assignee: field.assignee,
      filledBy: field.assignee,
      changedByHuman: false,
      movedByHuman: moved,
      confirmedByHuman: false,
      rect,
    };
    const signerId = signerIdOf(id);
    if (signerId !== undefined) audit.signerId = signerId;
    const plan: PlannedField = { field, rect, audit };
    planned.push(plan);
    const humanValue = Object.hasOwn(input.values, id) ? input.values[id] : undefined;
    const signature = Object.hasOwn(input.signatures, id) ? input.signatures[id] : undefined;
    const confirmed = input.confirmed !== undefined && Object.hasOwn(input.confirmed, id);
    if (confirmed && (isSigningField(field) || field.value === undefined || field.assignee !== 'human')) {
      throw invalid(`Field "${id}" has no suggested value from the request that the human could confirm.`, id);
    }

    if (isSigningField(field)) {
      if (humanValue !== undefined) {
        throw invalid(`Field "${id}" is a ${field.type} field and cannot take a value.`, id);
      }
      const notSigned = () =>
        new SignPdfError('missing-required-field', `The ${field.type} field "${id}" is not signed.`, id);
      if (!signature || signature.png.length === 0) {
        if (field.required) throw notSigned();
        continue;
      }
      const problem = checkSignaturePng(signature.png);
      if (problem) {
        // A blank image on a required field is an unsigned field.
        if (problem.problem === 'no-ink' && field.required) throw notSigned();
        throw invalid(`Field "${id}": ${problem.message}`, id);
      }
      plan.signature = signature;
      audit.filledBy = 'human';
      audit.signatureMethod = signature.method;
      audit.signatureSha256 = await sha256Hex(signature.png);
      continue;
    }

    if (signature) {
      throw invalid(`Field "${id}" is a ${field.type} field and cannot take a signature image.`, id);
    }
    // Values are compared and recorded as they are drawn: cleaned of invisible characters.
    const requestValue: string | boolean | undefined =
      typeof field.value === 'string' ? cleanFieldText(field, field.value) : field.value;
    let value: string | boolean | undefined;
    if (humanValue !== undefined) {
      value = assertFieldValue(field, rect, humanValue, font);
      const changed = value !== requestValue;
      audit.filledBy = changed ? 'human' : 'agent';
      audit.changedByHuman = changed && requestValue !== undefined;
      audit.confirmedByHuman = confirmed && !changed;
    } else if (field.value !== undefined) {
      // The value written into the request stands; it must still fit where the field now is.
      value = assertFieldValue(field, rect, field.value, font);
      audit.filledBy = 'agent';
      audit.confirmedByHuman = confirmed;
    } else if (field.type === 'date' && field.assignee === 'human') {
      // UTC calendar day of signing. A UI that wants the signer's local day passes it as a value.
      value = assertFieldValue(field, rect, signedAtOf(id).slice(0, 10), font);
      audit.filledBy = 'human';
    }
    if (value !== undefined) audit.value = value;

    if (typeof value === 'string' && !isBlankText(value)) {
      const layout = layoutFieldText(field, rect, value, font);
      if ('code' in layout) throw new SignPdfError(layout.code, `Field "${id}": ${layout.message}`, id);
      plan.text = { value, layout };
    } else if (typeof value === 'boolean') {
      plan.checked = value;
    }
    // Required means visible content: text that shows, or a ticked box.
    const filled = plan.text !== undefined || plan.checked === true;
    if (field.required && !filled) {
      const what = field.type === 'checkbox' ? 'is not checked' : 'has no value';
      throw new SignPdfError('missing-required-field', `The required field "${id}" ${what}.`, id);
    }

    const placement = field.placement;
    if (placement.kind === 'acroField' && !moved && filled) {
      const acro = form?.getFieldMaybe(placement.name);
      if (!acro) {
        throw new SignPdfError(
          'acro-field-not-found',
          `Field "${id}": the form field ${JSON.stringify(placement.name)} does not exist.`,
          id,
        );
      }
      const matches = field.type === 'checkbox' ? acro instanceof PDFCheckBox : acro instanceof PDFTextField;
      // Any other pairing (a text value on a dropdown, say) is drawn into the widget's rectangle.
      if (matches && !usedAcroNames.has(placement.name)) {
        usedAcroNames.add(placement.name);
        // pdf-lib builds a field's appearance for an unrotated page. On a rotated page the
        // flattened value would lie sideways, so there the value is drawn and the field removed.
        const upright = pages[rect.page - 1]?.rotation === 0;
        if (upright) plan.fill = acro as PDFTextField | PDFCheckBox;
        else plan.replace = acro as PDFTextField | PDFCheckBox;
      }
    }
  }
  return planned;
}

/** Paint a form field's appearance into the page content, then remove the field. */
function flattenField(doc: PDFDocument, form: PDFForm, field: PDFTextField | PDFCheckBox, fieldId: string): void {
  const pages = doc.getPages();
  for (const widget of field.acroField.getWidgets()) {
    const page = pages[widgetPageIndex(doc, widget)];
    // A widget that is on no page shows nothing, so there is nothing to paint.
    if (!page) continue;
    let appearance: PDFRef | PDFDict | undefined = widget.getNormalAppearance();
    if (field instanceof PDFCheckBox) {
      // A check box keeps one appearance per state; pick the one for its current value.
      const states = appearance instanceof PDFRef ? doc.context.lookup(appearance) : appearance;
      const state =
        states instanceof PDFDict
          ? (states.get(field.acroField.getValue()) ?? states.get(PDFName.of('Off')))
          : undefined;
      appearance = state instanceof PDFRef ? state : undefined;
    }
    if (!(appearance instanceof PDFRef)) {
      throw invalid(`Field "${fieldId}": the form field "${field.getName()}" has no appearance to flatten.`, fieldId);
    }
    const rectangle = widget.getRectangle();
    const key = page.node.newXObject('FlatWidget', appearance);
    page.pushOperators(pushGraphicsState(), translate(rectangle.x, rectangle.y), drawObject(key), popGraphicsState());
  }
  form.removeField(field);
}

export async function finalizeDocument(
  pdf: Uint8Array,
  resolvedInput: ResolvedRequest,
  humanInput: HumanInput | readonly HumanInput[],
  options: FinalizeOptions = {},
): Promise<FinalizeResult> {
  // Everything given here crossed a trust boundary (browser state, a packet): check it all again.
  if (!(pdf instanceof Uint8Array)) throw new SignPdfError('invalid-pdf', 'The PDF must be given as bytes.');
  assertPdfSize(pdf.length);
  // Parsed by shape, not as a union, so a mistake is reported at its own path.
  const parsedInput = Array.isArray(humanInput)
    ? z.array(HumanInputSchema).min(1).max(MAX_SIGNERS).safeParse(humanInput)
    : HumanInputSchema.safeParse(humanInput);
  if (!parsedInput.success) {
    throw invalid(`Invalid signing input: ${formatIssues(parsedInput.error.issues)}`);
  }
  const given = Array.isArray(parsedInput.data) ? parsedInput.data : [parsedInput.data];
  if (resolvedInput === null || typeof resolvedInput !== 'object') {
    throw invalid('The resolved request is missing.');
  }
  const request = validateRequest(resolvedInput.request);
  const resolved: ResolvedRequest = { ...resolvedInput, request };
  await assertDocumentHash(pdf, request);

  const { input, passes, passOf } = checkPassPrefix(request, given, new Date().toISOString(), { complete: true });
  const multi = request.signers !== undefined;
  const last = passes[passes.length - 1];
  if (!last) throw invalid('No signing input was given.');
  const signedAt = last.signedAt;
  const passAt = (id: string) => {
    const index = passOf.get(id);
    return index === undefined ? undefined : passes[index];
  };

  const { doc, pages } = await loadPdf(pdf);
  const form = hasAcroForm(doc) ? doc.getForm() : undefined;
  const textFont = await loadTextFont(options);
  const planned = await planFields(
    resolved,
    input,
    (id) => passAt(id)?.signedAt ?? signedAt,
    (id) => passAt(id)?.signerId,
    pages,
    form,
    textFont,
  );

  const requestHash = await requestSha256(request);
  const auditCandidate: AuditRecord = {
    version: SPEC_VERSION,
    app: { name: APP_NAME, version: CORE_VERSION },
    document: { name: request.document.name, originalSha256: request.document.sha256 },
    requestSha256: requestHash,
    signer: { name: last.signerName },
    consent: { text: last.consent.text, acceptedAt: last.consent.acceptedAt },
    signedAt,
    fields: planned.map((plan) => plan.audit),
  };
  if (multi) {
    const unchained: Omit<AuditPass, 'previousSha256'>[] = passes.map((pass) => ({
      signerId: pass.signerId ?? '',
      signer: { name: pass.signerName },
      consent: { text: pass.consent.text, acceptedAt: pass.consent.acceptedAt },
      signedAt: pass.signedAt,
      fieldIds: request.fields.filter((field) => field.signerId === pass.signerId).map((field) => field.id),
    }));
    auditCandidate.passes = await chainPasses(requestHash, unchained);
  }
  const auditParsed = AuditRecord.safeParse(auditCandidate);
  if (!auditParsed.success) {
    throw invalid(`The signing details are invalid: ${formatIssues(auditParsed.error.issues)}`);
  }
  const audit = auditParsed.data;

  let font: PDFFont | undefined;
  if (planned.some((plan) => plan.text)) {
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(textFont.bytes, { subset: true });
  }
  const pdfPages = doc.getPages();

  for (const plan of planned) {
    const id = plan.field.id;
    const geometry = pages[plan.rect.page - 1];
    const page = pdfPages[plan.rect.page - 1];
    if (!geometry || !page) throw new Error(`Page ${plan.rect.page} disappeared while writing.`);

    if (plan.signature) {
      let image: PDFImage;
      try {
        image = await doc.embedPng(plan.signature.png);
      } catch (error) {
        throw invalid(`Field "${id}": the signature image is not a usable PNG: ${errorMessage(error)}`, id);
      }
      drawInRect(page, geometry, plan.rect, () => drawSignature(page, plan.rect, image));
    } else if (plan.fill && form) {
      const acro = plan.fill;
      try {
        if (acro instanceof PDFCheckBox) {
          acro.check();
          acro.defaultUpdateAppearances();
        } else {
          if (!font || !plan.text) throw new Error('no text was prepared');
          // The size the value was checked at; the form field does its own alignment and wrapping.
          acro.setFontSize(plan.text.layout.size);
          acro.setText(plan.text.value);
          acro.updateAppearances(font);
        }
      } catch (error) {
        throw invalid(`Field "${id}": the form field "${acro.getName()}" could not be filled: ${errorMessage(error)}`, id);
      }
      flattenField(doc, form, acro, id);
    } else {
      const { text, checked } = plan;
      if (text) {
        if (!font) throw new Error('no font was embedded');
        const embedded = font;
        drawInRect(page, geometry, plan.rect, () => drawTextLayout(page, text.layout, embedded));
      } else if (checked) {
        drawInRect(page, geometry, plan.rect, () => drawCheckMark(page, plan.rect));
      }
      if (plan.replace && form) form.removeField(plan.replace);
    }
  }

  const stamp = new Date(signedAt);
  await doc.attach(utf8(JSON.stringify(audit, null, 2)), AUDIT_ATTACHMENT_NAME, {
    mimeType: 'application/json',
    description: 'sign-pdf audit record',
    creationDate: stamp,
    modificationDate: stamp,
  });

  // Fields were given their appearances above; a blanket refresh would redraw
  // untouched fields with a font that cannot encode every character.
  const signed = await doc.save({ updateFieldAppearances: false });
  return { pdf: signed, audit, sha256: await sha256Hex(signed) };
}
