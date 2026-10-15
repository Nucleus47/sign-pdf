/**
 * Test-only helpers: synthetic fixtures built in code and a small content-stream
 * reader for checking where marks landed. Not part of the public API.
 */
import { crc32, deflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream } from '@cantoo/pdf-lib';
import type { FieldInput, SignRequestInput } from '@sign-pdf/spec';
import { sha256Hex } from './index.ts';
import type { HumanInput } from './sign.ts';

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type));
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return pngChunk('IHDR', header);
}

/** A PNG of the given size filled with one RGBA colour. Default: opaque black. */
export function makePng(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number] = [0, 0, 0, 255],
): Uint8Array {
  const row = new Uint8Array(1 + width * 4); // filter byte 0, then pixels
  for (let x = 0; x < width; x++) row.set(rgba, 1 + x * 4);
  const raw = new Uint8Array(height * row.length);
  for (let y = 0; y < height; y++) raw.set(row, y * row.length);
  return joinBytes([PNG_SIGNATURE, pngHeader(width, height), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array(0))]);
}

/**
 * An 8-bit RGBA PNG header for the given size, with `raw` (deflated here) as
 * its image data and `extra` chunks before it: for images whose data does
 * not match their size.
 */
export function makePngFromRaw(width: number, height: number, raw: Uint8Array, extra: [string, Uint8Array][] = []): Uint8Array {
  return joinBytes([
    PNG_SIGNATURE,
    pngHeader(width, height),
    ...extra.map(([type, data]) => pngChunk(type, data)),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/** A PNG whose header claims the given size but which carries no pixel data. */
export function makePngHeaderOnly(width: number, height: number): Uint8Array {
  return joinBytes([PNG_SIGNATURE, pngHeader(width, height), pngChunk('IEND', new Uint8Array(0))]);
}

export async function requestFor(
  pdf: Uint8Array,
  fields: FieldInput[],
  extra: Partial<SignRequestInput> = {},
): Promise<SignRequestInput> {
  return {
    version: 1,
    document: { name: 'fixture.pdf', sha256: await sha256Hex(pdf) },
    fields,
    ...extra,
  };
}

/**
 * A US Letter page with a heading, a `Signature:` label whose baseline is 580
 * points from the top, a `Date:` label, and one text form field named
 * `full_name`. Extra pages carry an "Appendix n" heading. The same document as
 * the CLI's test fixture.
 */
export async function fixturePdf(options: { pages?: number } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Agreement between Example Co and Sample LLC', { x: 72, y: 720, size: 12, font });
  page.drawText('Signature:', { x: 72, y: 212, size: 12, font });
  page.drawText('Date:', { x: 340, y: 212, size: 12, font });
  const field = doc.getForm().createTextField('full_name');
  field.addToPage(page, { x: 72, y: 600, width: 200, height: 20, font });
  for (let extra = 1; extra < (options.pages ?? 1); extra++) {
    doc.addPage([612, 792]).drawText(`Appendix ${extra}`, { x: 72, y: 720, size: 12, font });
  }
  return doc.save();
}

export function humanInput(overrides: Partial<HumanInput> = {}): HumanInput {
  return {
    signerName: 'Ada Example',
    consent: { text: 'I agree to sign this document electronically.', acceptedAt: '2031-03-04T09:59:00.000Z' },
    values: {},
    signatures: {},
    signedAt: '2031-03-04T10:00:00.000Z',
    ...overrides,
  };
}

type Matrix = [number, number, number, number, number, number];

/** `first` applied, then `second`. */
function compose(first: Matrix, second: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = second;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function tokenize(content: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < content.length) {
    const char = content.charAt(i);
    if (/\s/.test(char)) {
      i++;
    } else if (char === '(') {
      // Literal string: skip to the matching parenthesis, honouring escapes.
      let depth = 1;
      i++;
      while (i < content.length && depth > 0) {
        const c = content.charAt(i);
        if (c === '\\') i++;
        else if (c === '(') depth++;
        else if (c === ')') depth--;
        i++;
      }
      tokens.push('(string)');
    } else if (char === '<' && content.charAt(i + 1) !== '<') {
      i = content.indexOf('>', i) + 1;
      tokens.push('<hex>');
    } else if (char === '[' || char === ']') {
      tokens.push(char);
      i++;
    } else {
      let end = i + 1;
      while (end < content.length && !/[\s()<>[\]/]/.test(content.charAt(end))) end++;
      tokens.push(content.slice(i, end));
      i = end;
    }
  }
  return tokens;
}

export interface PageMarks {
  /** Each painted XObject (image or flattened widget) with the PDF-native box its unit square maps to. */
  objects: Array<{ name: string; x: number; y: number; width: number; height: number }>;
  /** PDF-native end points of every moveto and lineto. */
  pathPoints: Array<[number, number]>;
}

/** Read where a page's own content stream paints XObjects and path points. */
export async function readPageMarks(pdf: Uint8Array, pageNumber: number): Promise<PageMarks> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPages()[pageNumber - 1];
  if (!page) throw new Error(`no page ${pageNumber}`);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  let text = '';
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) throw new Error('unexpected content stream type');
    text += `${new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode())}\n`;
  }

  const marks: PageMarks = { objects: [], pathPoints: [] };
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let operands: string[] = [];
  const numbers = (count: number) => operands.slice(-count).map(Number);
  for (const token of tokenize(text)) {
    if (/^[-+.\d]/.test(token) || token.startsWith('/') || token.startsWith('(') || token.startsWith('<') || token === '[' || token === ']') {
      operands.push(token);
      continue;
    }
    if (token === 'q') stack.push(ctm);
    else if (token === 'Q') ctm = stack.pop() ?? ctm;
    else if (token === 'cm') ctm = compose(numbers(6) as Matrix, ctm);
    else if (token === 'm' || token === 'l') {
      const [x = 0, y = 0] = numbers(2);
      marks.pathPoints.push(apply(ctm, x, y));
    } else if (token === 'Do') {
      const [x0, y0] = apply(ctm, 0, 0);
      const [x1, y1] = apply(ctm, 1, 1);
      marks.objects.push({
        name: (operands.at(-1) ?? '').slice(1),
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
      });
    }
    operands = [];
  }
  return marks;
}
