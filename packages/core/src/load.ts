import { PDFDocument } from '@cantoo/pdf-lib';
import { SignPdfError, errorMessage } from './errors.ts';
import { pageGeometry, type PageGeometry } from './geometry.ts';
import { assertPdfSize } from './limits.ts';

export interface LoadedPdf {
  doc: PDFDocument;
  pages: PageGeometry[];
}

/** Parse a PDF, mapping failures to SignPdfError('encrypted-pdf' | 'invalid-pdf'). */
export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  assertPdfSize(bytes.length);
  let doc: PDFDocument;
  try {
    // updateMetadata false: loading must not touch the document's own metadata.
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : '';
    if (name === 'EncryptedPDFError' || /is encrypted/i.test(errorMessage(error))) {
      throw new SignPdfError('encrypted-pdf', 'The PDF is encrypted. Remove the password protection first.');
    }
    throw new SignPdfError('invalid-pdf', `The file could not be read as a PDF: ${errorMessage(error)}`);
  }
  let pages: PageGeometry[];
  try {
    pages = doc.getPages().map((page, index) => pageGeometry(page, index + 1));
  } catch (error) {
    throw new SignPdfError('invalid-pdf', `The PDF's pages could not be read: ${errorMessage(error)}`);
  }
  if (pages.length === 0) throw new SignPdfError('invalid-pdf', 'The PDF has no pages.');
  for (const page of pages) {
    if (!(page.width > 0 && page.height > 0)) {
      throw new SignPdfError('invalid-pdf', `Page ${page.page} has no usable size.`);
    }
  }
  return { doc, pages };
}
