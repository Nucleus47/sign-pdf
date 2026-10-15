import { SignPdfError } from './errors.ts';

/** Largest PDF, in bytes, that any entry point accepts. */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

/** Largest packet text, in characters, that `decodePacket` parses: a full-size PDF in base64 plus the request. */
export const MAX_PACKET_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4 * 1024 * 1024;

/**
 * Largest hand-off packet, in characters, that `readHandoffPdf` parses: a packet
 * plus the finished passes, whose signature images the spec caps one by one.
 */
export const MAX_HANDOFF_CHARS = MAX_PACKET_CHARS + 32 * 1024 * 1024;

/** Largest audit record, in bytes, that `verifySignedPdf` inflates and reads. */
export const MAX_AUDIT_RECORD_BYTES = 16 * 1024 * 1024;

/** Largest width or height, in pixels, of a signature or initials image. */
export const MAX_SIGNATURE_IMAGE_SIDE = 4096;

const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

export function assertPdfSize(byteLength: number, code: 'invalid-pdf' | 'invalid-packet' = 'invalid-pdf'): void {
  if (byteLength > MAX_PDF_BYTES) {
    throw new SignPdfError(
      code,
      `The PDF is too large: ${megabytes(byteLength)}. The limit is ${megabytes(MAX_PDF_BYTES)}.`,
    );
  }
}

/** The default cap on `findPlacementCandidates` results. */
export const MAX_PLACEMENT_CANDIDATES = 200;
