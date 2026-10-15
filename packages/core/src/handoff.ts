/**
 * The hand-off PDF: the signatures so far, drawn for viewing only, plus the
 * packet the next signer needs. Reached only through `./sign.ts`, because it
 * takes signature images.
 */
import * as fontkit from '@cantoo/fontkit';
import { type PDFFont, type PDFImage } from '@cantoo/pdf-lib';
import {
  HANDOFF_ATTACHMENT_NAME,
  MAX_SIGNERS,
  PACKET_KIND,
  Packet,
  SPEC_VERSION,
  type PacketPass,
  type ResolvedRequest,
} from '@sign-pdf/spec';
import { z } from 'zod';
import { drawCheckMark, drawInRect, drawSignature, drawTextLayout } from './draw.ts';
import { SignPdfError, errorMessage, formatIssues } from './errors.ts';
import { bytesToBase64, utf8 } from './hash.ts';
import { hasAcroForm } from './inspect.ts';
import { MAX_PDF_BYTES, assertPdfSize } from './limits.ts';
import { loadPdf } from './load.ts';
import { assertDocumentHash, validateRequest } from './resolve.ts';
import type { HandoffOptions, HandoffResult, HumanInput } from './sign.ts';
import { loadTextFont } from './text-font.ts';
import { HumanInputSchema, checkPassPrefix, planFields, type MergedPasses } from './write.ts';

function invalid(message: string): SignPdfError {
  return new SignPdfError('invalid-request', message);
}

function toPacketPass(pass: MergedPasses['passes'][number]): PacketPass {
  const signatures: PacketPass['signatures'] = {};
  for (const [id, signature] of Object.entries(pass.signatures)) {
    signatures[id] = { pngBase64: bytesToBase64(signature.png), method: signature.method };
  }
  const out: PacketPass = {
    signerId: pass.signerId ?? '',
    signerName: pass.signerName,
    consent: { text: pass.consent.text, acceptedAt: pass.consent.acceptedAt },
    signedAt: pass.signedAt,
    values: { ...pass.values },
    signatures,
  };
  if (pass.rects !== undefined) out.rects = { ...pass.rects };
  if (pass.confirmed !== undefined) out.confirmed = { ...pass.confirmed };
  return out;
}

export async function buildHandoffPdf(
  pdf: Uint8Array,
  resolvedInput: ResolvedRequest,
  passesInput: readonly HumanInput[],
  options: HandoffOptions = {},
): Promise<HandoffResult> {
  // Everything given here crossed a trust boundary (browser state, a packet): check it all again.
  if (!(pdf instanceof Uint8Array)) throw new SignPdfError('invalid-pdf', 'The PDF must be given as bytes.');
  assertPdfSize(pdf.length);
  const parsedInput = z
    .array(HumanInputSchema)
    .min(1)
    .max(MAX_SIGNERS - 1)
    .safeParse(passesInput);
  if (!parsedInput.success) throw invalid(`Invalid signing input: ${formatIssues(parsedInput.error.issues)}`);
  if (resolvedInput === null || typeof resolvedInput !== 'object') throw invalid('The resolved request is missing.');
  const request = validateRequest(resolvedInput.request);
  const resolved: ResolvedRequest = { ...resolvedInput, request };
  await assertDocumentHash(pdf, request);

  const { input, passes, passOf } = checkPassPrefix(request, parsedInput.data, new Date().toISOString(), {
    complete: false,
  });
  const total = request.signers?.length ?? 1;
  const done = new Set(passes.map((pass) => pass.signerId));
  const passAt = (id: string) => {
    const index = passOf.get(id);
    return index === undefined ? undefined : passes[index];
  };
  const lastSignedAt = passes.at(-1)?.signedAt ?? new Date().toISOString();

  const packetParsed = Packet.safeParse({
    kind: PACKET_KIND,
    version: SPEC_VERSION,
    request,
    pdfBase64: bytesToBase64(pdf),
    passes: passes.map(toPacketPass),
  });
  if (!packetParsed.success) throw invalid(`The hand-off is invalid: ${formatIssues(packetParsed.error.issues)}`);
  const packet = packetParsed.data;

  const { doc, pages } = await loadPdf(pdf);
  const form = hasAcroForm(doc) ? doc.getForm() : undefined;
  const textFont = await loadTextFont(options);
  // The same checks as at signing, for the finished signers' fields and the agent's.
  // Fields of the signers still to come are left out: they are neither checked nor drawn.
  const planned = await planFields(
    resolved,
    input,
    (id) => passAt(id)?.signedAt ?? lastSignedAt,
    (id) => passAt(id)?.signerId,
    pages,
    form,
    textFont,
    (field) => field.signerId === undefined || done.has(field.signerId),
  );

  let font: PDFFont | undefined;
  if (planned.some((plan) => plan.text)) {
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(textFont.bytes, { subset: true });
  }
  const pdfPages = doc.getPages();
  // Drawn for viewing only: form fields are neither filled nor flattened, and no audit record is written.
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
        throw new SignPdfError(
          'invalid-request',
          `Field "${id}": the signature image is not a usable PNG: ${errorMessage(error)}`,
          id,
        );
      }
      drawInRect(page, geometry, plan.rect, () => drawSignature(page, plan.rect, image));
    } else if (plan.text) {
      if (!font) throw new Error('no font was embedded');
      const embedded = font;
      const layout = plan.text.layout;
      drawInRect(page, geometry, plan.rect, () => drawTextLayout(page, layout, embedded));
    } else if (plan.checked) {
      drawInRect(page, geometry, plan.rect, () => drawCheckMark(page, plan.rect));
    }
  }

  const at = new Date(lastSignedAt);
  await doc.attach(utf8(JSON.stringify(packet)), HANDOFF_ATTACHMENT_NAME, {
    mimeType: 'application/json',
    description: 'sign-pdf hand-off to the next signer (not final)',
    creationDate: at,
    modificationDate: at,
  });
  const out = await doc.save({ updateFieldAppearances: false });
  if (out.length > MAX_PDF_BYTES) {
    throw new SignPdfError(
      'invalid-pdf',
      'The hand-off PDF would be larger than the PDF size limit. Sign on this device instead.',
    );
  }
  return { pdf: out, packet: { ...packet, passes: packet.passes ?? [] } };
}
