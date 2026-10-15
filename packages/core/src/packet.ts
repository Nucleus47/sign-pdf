import {
  HANDOFF_ATTACHMENT_NAME,
  PACKET_KIND,
  Packet,
  SPEC_VERSION,
  type PacketPass,
  type SignRequestInput,
} from '@sign-pdf/spec';
import type { PDFDocument } from '@cantoo/pdf-lib';
import { AttachmentError, readNamedAttachments } from './attachments.ts';
import { SignPdfError, errorMessage, formatIssues } from './errors.ts';
import { base64ToBytes, bytesToBase64, sha256Hex } from './hash.ts';
import { MAX_HANDOFF_CHARS, MAX_PACKET_CHARS, MAX_PDF_BYTES, assertPdfSize } from './limits.ts';
import { loadPdf } from './load.ts';
import { checkSignaturePng } from './png.ts';
import { assertDocumentHash, validateRequest } from './resolve.ts';
import type { HumanInput } from './sign.ts';

export async function createPacket(pdf: Uint8Array, input: SignRequestInput): Promise<Packet> {
  assertPdfSize(pdf.length);
  const request = validateRequest(input);
  await assertDocumentHash(pdf, request);
  return { kind: PACKET_KIND, version: SPEC_VERSION, request, pdfBase64: bytesToBase64(pdf) };
}

export function encodePacket(packet: Packet): string {
  return `${JSON.stringify(packet)}\n`;
}

export async function decodePacket(text: string): Promise<{ packet: Packet; pdf: Uint8Array }> {
  // Checked before parsing, so an oversized packet costs nothing.
  if (text.length > MAX_PACKET_CHARS) {
    throw new SignPdfError('invalid-packet', 'The packet is too large to hold a PDF within the size limit.');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SignPdfError('invalid-packet', 'The packet is not valid JSON.');
  }
  const parsed = Packet.safeParse(json);
  if (!parsed.success) {
    throw new SignPdfError('invalid-packet', `Invalid packet: ${formatIssues(parsed.error.issues)}`);
  }
  const packet = parsed.data;
  const pdf = base64ToBytes(packet.pdfBase64);
  if (!pdf) throw new SignPdfError('invalid-packet', 'Invalid packet: pdfBase64 is not padded standard base64.');
  assertPdfSize(pdf.length, 'invalid-packet');
  await assertDocumentHash(pdf, packet.request);
  return { packet, pdf };
}

/** What a hand-off PDF carries. */
export interface HandoffContents {
  /** The packet, with the finished signers' `passes`. */
  packet: Packet & { passes: PacketPass[] };
  /** The original PDF, as the request was written for it. The next signer signs this, not the hand-off PDF. */
  pdf: Uint8Array;
  /** The finished passes, ready to pass to `finalizeDocument` before the remaining signers' passes. */
  passes: HumanInput[];
}

const handoffError = (message: string) => new SignPdfError('invalid-handoff', message);

/**
 * The hand-off attachments of a loaded PDF, each inflated to at most
 * MAX_HANDOFF_CHARS. Throws SignPdfError('invalid-handoff') when one cannot be read.
 */
export function handoffAttachments(doc: PDFDocument): Uint8Array[] {
  try {
    return readNamedAttachments(doc, HANDOFF_ATTACHMENT_NAME, MAX_HANDOFF_CHARS, 'hand-off data');
  } catch (error) {
    if (error instanceof AttachmentError) throw handoffError(error.message);
    throw handoffError(`The PDF's attachments could not be read: ${errorMessage(error)}`);
  }
}

/**
 * Check one hand-off attachment strictly: its size, the packet schema (passes
 * included), the embedded original's hash, and every signature image.
 */
export async function decodeHandoff(data: Uint8Array): Promise<HandoffContents> {
  if (data.length > MAX_HANDOFF_CHARS) throw handoffError('The hand-off data is too large.');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw handoffError('The hand-off data is not valid JSON.');
  }
  const parsed = Packet.safeParse(json);
  if (!parsed.success) throw handoffError(`Invalid hand-off data: ${formatIssues(parsed.error.issues)}`);
  const packet = parsed.data;
  const packetPasses = packet.passes;
  if (packetPasses === undefined) throw handoffError('The hand-off data has no finished signer.');

  const pdf = base64ToBytes(packet.pdfBase64);
  if (!pdf) throw handoffError('Invalid hand-off data: pdfBase64 is not padded standard base64.');
  if (pdf.length > MAX_PDF_BYTES) throw handoffError('The original PDF in the hand-off data is too large.');
  if ((await sha256Hex(pdf)) !== packet.request.document.sha256) {
    throw handoffError('The original PDF in the hand-off data does not match its request: it was changed.');
  }

  const passes = packetPasses.map((pass): HumanInput => {
    const signatures: HumanInput['signatures'] = {};
    for (const [id, signature] of Object.entries(pass.signatures)) {
      const png = base64ToBytes(signature.pngBase64);
      // The schema already checked the base64; decoding cannot fail here.
      const problem = png ? checkSignaturePng(png) : { message: 'the signature image is not base64.' };
      if (!png || problem) throw handoffError(`Field "${id}" in the hand-off data: ${problem?.message ?? ''}`);
      signatures[id] = { png, method: signature.method };
    }
    const input: HumanInput = {
      signerId: pass.signerId,
      signerName: pass.signerName,
      consent: { ...pass.consent },
      signedAt: pass.signedAt,
      values: { ...pass.values },
      signatures,
    };
    if (pass.rects !== undefined) input.rects = { ...pass.rects };
    if (pass.confirmed !== undefined) input.confirmed = { ...pass.confirmed };
    return input;
  });
  return { packet: { ...packet, passes: packetPasses }, pdf, passes };
}

/**
 * Read the packet a hand-off PDF carries. Returns null for a PDF without one,
 * such as an ordinary or a final signed PDF. Throws SignPdfError: 'invalid-pdf'
 * or 'encrypted-pdf' when the file cannot be read, and 'invalid-handoff' when
 * the hand-off data is damaged, changed, or more than one.
 *
 * The hand-off data is untrusted: anyone who holds the file can change it.
 * These checks catch damage and a changed original, not a forged signer.
 */
export async function readHandoffPdf(bytes: Uint8Array): Promise<HandoffContents | null> {
  const { doc } = await loadPdf(bytes);
  const found = handoffAttachments(doc);
  const [data] = found;
  if (data === undefined) return null;
  if (found.length > 1) throw handoffError(`The PDF carries ${found.length} hand-off attachments; it must carry one.`);
  return decodeHandoff(data);
}
