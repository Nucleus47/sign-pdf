/**
 * Synthetic PDFs and packets for the end-to-end tests, written by hand so the
 * suite needs no PDF library and no fixture file.
 */
import { createHash } from 'node:crypto';

export interface TestText {
  text: string;
  /** PDF-native position: points from the bottom-left of the unrotated page. */
  x: number;
  y: number;
  size?: number;
}

export interface TestPage {
  width?: number;
  height?: number;
  /** The page's /Rotate entry. */
  rotate?: 0 | 90 | 180 | 270;
  texts?: TestText[];
}

function escapeText(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

/** A valid PDF 1.4 file with one Helvetica font and the given pages. */
export function buildPdf(pages: readonly TestPage[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_page, index) => `${4 + index * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, index) => {
    const content = (page.texts ?? [])
      .map((item) => `BT /F1 ${item.size ?? 12} Tf ${item.x} ${item.y} Td (${escapeText(item.text)}) Tj ET`)
      .join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width ?? 612} ${page.height ?? 792}] ` +
        `/Rotate ${page.rotate ?? 0} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export interface PacketOptions {
  name?: string;
  title?: string;
  note?: string;
  signers?: { id: string; name?: string }[];
  fields: Record<string, unknown>[];
}

/** The text of a packet file for this PDF: what a preparing agent would hand over. */
export function buildPacketText(pdf: Buffer, options: PacketOptions): string {
  const request: Record<string, unknown> = {
    version: 1,
    document: {
      name: options.name ?? 'synthetic.pdf',
      sha256: createHash('sha256').update(pdf).digest('hex'),
    },
    fields: options.fields,
  };
  if (options.title !== undefined) request.title = options.title;
  if (options.note !== undefined) request.note = options.note;
  if (options.signers !== undefined) request.signers = options.signers;
  return JSON.stringify({ kind: 'sign-pdf-packet', version: 1, request, pdfBase64: pdf.toString('base64') });
}

/** A rect placement in the request's coordinates: points from the top-left of the page as displayed. */
export function rectAt(page: number, x: number, y: number, width: number, height: number): Record<string, unknown> {
  return { kind: 'rect', page, x, y, width, height };
}
