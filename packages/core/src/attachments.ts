/**
 * Read one named attachment of a PDF without inflating anything else, and
 * with a hard cap on what it inflates to. pdf-lib's `getAttachments` inflates
 * every embedded file in full, which a small file can turn into gigabytes.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  type PDFDocument,
} from '@cantoo/pdf-lib';
import { inflateCapped } from './inflate.ts';

/** Thrown when an attachment cannot be read within the rules. The message is for people. */
export class AttachmentError extends Error {}

function embeddedFileNames(doc: PDFDocument): PDFArray | undefined {
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const files = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  return files?.lookupMaybe(PDFName.of('Names'), PDFArray);
}

function decodeName(value: unknown): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

function contentsOf(stream: PDFRawStream, label: string, maxBytes: number): Uint8Array {
  const dict = stream.dict;
  const declared = dict.lookupMaybe(PDFName.of('Params'), PDFDict)?.lookupMaybe(PDFName.of('Size'), PDFNumber);
  if (declared !== undefined && declared.asNumber() > maxBytes) throw new AttachmentError(`The ${label} is too large.`);
  const length = dict.lookupMaybe(PDFName.of('Length'), PDFNumber);
  if (length !== undefined && length.asNumber() !== stream.contents.length) {
    throw new AttachmentError(`The ${label} has a length that does not match its data.`);
  }
  if (dict.has(PDFName.of('DecodeParms'))) throw new AttachmentError(`The ${label} uses an encoding that is not supported.`);
  const filter = dict.lookup(PDFName.of('Filter'));
  const flate = PDFName.of('FlateDecode');
  if (filter === undefined) {
    if (stream.contents.length > maxBytes) throw new AttachmentError(`The ${label} is too large.`);
    return stream.contents;
  }
  if (filter !== flate && !(filter instanceof PDFArray && filter.size() === 1 && filter.lookup(0) === flate)) {
    throw new AttachmentError(`The ${label} uses an encoding that is not supported.`);
  }
  let data: Uint8Array | undefined;
  try {
    data = inflateCapped(stream.contents, maxBytes);
  } catch {
    throw new AttachmentError(`The ${label} is damaged: its data cannot be decompressed.`);
  }
  if (data === undefined) throw new AttachmentError(`The ${label} is too large.`);
  return data;
}

/**
 * The data of every attachment called `name`, in document order. Other
 * attachments are not inflated. Only plain and FlateDecode files are read.
 * Throws AttachmentError when one of them is larger than `maxBytes` once
 * inflated, or cannot be read.
 */
export function readNamedAttachments(doc: PDFDocument, name: string, maxBytes: number, label: string): Uint8Array[] {
  const names = embeddedFileNames(doc);
  if (names === undefined) return [];
  const found: Uint8Array[] = [];
  for (let index = 0; index + 1 < names.size(); index += 2) {
    if (decodeName(names.lookup(index)) !== name) continue;
    const spec = names.lookup(index + 1);
    const ef = spec instanceof PDFDict ? spec.lookupMaybe(PDFName.of('EF'), PDFDict) : undefined;
    const stream = ef?.lookup(PDFName.of('F'));
    if (!(stream instanceof PDFRawStream)) throw new AttachmentError(`The ${label} has no readable data.`);
    found.push(contentsOf(stream, label, maxBytes));
  }
  return found;
}
