import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from '@cantoo/pdf-lib';
import type { FieldType, Rect } from '@sign-pdf/spec';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

type DrawCase = (page: PDFPage, font: PDFFont, doc: PDFDocument) => void;

async function syntheticPdf(draw: DrawCase): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  draw(page, font, doc);
  return doc.save();
}

/** Rectangles use the core's top-left, point-based display coordinates. */
interface ExpectedField {
  type: FieldType;
  rect: Omit<Rect, 'page'>;
  page: number;
}

const expected = (type: FieldType, x: number, y: number, width: number, height: number, page = 1): ExpectedField => ({
  type,
  rect: { x, y, width, height },
  page,
});

export interface CandidateEvalCase {
  name: string;
  pdf: () => Promise<Uint8Array>;
  expected: ExpectedField[];
  /** Candidate placements in these regions are known harmless extras. */
  acceptableExtras?: Rect[];
}

/**
 * Add a case in three steps: draw a synthetic page with `syntheticPdf`, list
 * its ground-truth field type and rectangle, and add it to this array. Keep
 * documents small and generated in code; never add PDF fixtures or network dependencies.
 */
export const candidateEvalCorpus: CandidateEvalCase[] = [
  {
    name: 'open signature blank above a caption without a rule',
    pdf: () => syntheticPdf((page, font) => {
      page.drawText('Applicant signature', { x: 72, y: 640, size: 10, font });
    }),
    expected: [expected('signature', 72, 122, 220, 20)],
  },
  {
    name: 'caption below a signature blank',
    pdf: () => syntheticPdf((page, font) => {
      page.drawLine({ start: { x: 72, y: 650 }, end: { x: 400, y: 650 }, thickness: 0.5 });
      page.drawText('Applicant signature', { x: 72, y: 636, size: 10, font });
    }),
    expected: [expected('signature', 72, 122, 328, 20)],
  },
  {
    name: 'repeated spouse signature captions',
    pdf: () => syntheticPdf((page, font) => {
      page.drawLine({ start: { x: 72, y: 690 }, end: { x: 300, y: 690 }, thickness: 0.5 });
      page.drawText("Spouse's signature", { x: 72, y: 676, size: 10, font });
      page.drawLine({ start: { x: 72, y: 600 }, end: { x: 300, y: 600 }, thickness: 0.5 });
      page.drawText("Spouse's signature", { x: 72, y: 586, size: 10, font });
    }),
    expected: [expected('signature', 72, 82, 228, 20), expected('signature', 72, 172, 228, 20)],
  },
  {
    name: 'signature and date header row with cells below',
    pdf: () => syntheticPdf((page, font) => {
      // The header row is above a bordered blank-cell row, not labels beside
      // independent line blanks. The table interiors are the ground truth.
      page.drawText('Signature', { x: 82, y: 690, size: 10, font });
      page.drawText('Date', { x: 340, y: 690, size: 10, font });
      for (const y of [715, 675, 620]) {
        page.drawLine({ start: { x: 72, y }, end: { x: 540, y }, thickness: 0.5 });
      }
      for (const x of [72, 320, 540]) {
        page.drawLine({ start: { x, y: 715 }, end: { x, y: 620 }, thickness: 0.5 });
      }
    }),
    expected: [expected('signature', 74, 119, 244, 51), expected('date', 322, 119, 216, 51)],
  },
  {
    name: 'drawn lines after signature and date labels',
    pdf: () => syntheticPdf((page, font) => {
      page.drawText('Your signature', { x: 72, y: 690, size: 12, font });
      page.drawLine({ start: { x: 150, y: 690 }, end: { x: 400, y: 690 }, thickness: 0.5 });
      page.drawText('Date', { x: 420, y: 690, size: 12, font });
      page.drawLine({ start: { x: 450, y: 690 }, end: { x: 560, y: 690 }, thickness: 0.5 });
    }),
    expected: [expected('signature', 150, 82, 250, 20), expected('date', 450, 88, 110, 14)],
  },
  {
    name: 'signature and date underscore variants',
    pdf: () => syntheticPdf((page, font) => {
      page.drawText('Signature: ____________________', { x: 72, y: 650, size: 10, font });
      page.drawText('Date: __________', { x: 72, y: 610, size: 10, font });
    }),
    // Candidate target geometry follows the printed underscore run.
    expected: [expected('signature', 125, 120, 112, 20), expected('date', 100, 168, 52, 14)],
  },
  {
    name: 'bare underscore run',
    pdf: () => syntheticPdf((page, font) => page.drawText('____________________', { x: 100, y: 650, size: 12, font })),
    expected: [expected('text', 100, 128, 134, 14)],
  },
  {
    name: 'date and initials underscore runs',
    pdf: () => syntheticPdf((page, font) => {
      page.drawText('Date: __________', { x: 72, y: 650, size: 10, font });
      page.drawText('Initials: ______', { x: 320, y: 650, size: 10, font });
    }),
    expected: [expected('date', 100, 128, 54, 14), expected('initials', 360, 122, 30, 20)],
  },
  {
    name: 'visible AcroForm widget',
    pdf: () => syntheticPdf((_page, font, doc) => {
      doc.getForm().createTextField('account_holder_name').addToPage(doc.getPages()[0]!, {
        x: 72, y: 500, width: 180, height: 20, font,
      });
    }),
    expected: [expected('text', 72, 272, 180, 20)],
  },
  {
    name: 'empty preparer signature block is not a signer blank',
    pdf: () => syntheticPdf((page, font) => {
      page.drawText('Preparer signature for office use only', { x: 72, y: 650, size: 10, font });
      page.drawLine({ start: { x: 72, y: 600 }, end: { x: 300, y: 600 }, thickness: 0.5 });
    }),
    expected: [],
  },
  {
    name: 'body prose with a colon',
    pdf: () => syntheticPdf((page, font) => {
      page.drawText('The parties agree to the terms below, in the order given here:', { x: 72, y: 650, size: 10, font });
      page.drawText('Terms: see the schedule attached to this agreement.', { x: 72, y: 620, size: 10, font });
    }),
    expected: [],
  },
  {
    name: 'preparer instructions with a colon',
    pdf: () => syntheticPdf((page, font) => {
      page.drawText('Preparer instructions: enter the tracking number and retain this page.', { x: 72, y: 650, size: 10, font });
      page.drawText('Do not sign here; this section is for administrative review only.', { x: 72, y: 620, size: 10, font });
    }),
    expected: [],
  },
  {
    name: 'ordinary paragraph mentioning signature and date',
    pdf: () => syntheticPdf((page, font) => {
      page.drawText('The signature and date must appear in the final copy of this agreement.', { x: 72, y: 650, size: 10, font });
      page.drawText('No fields or blank lines are provided on this page.', { x: 72, y: 620, size: 10, font });
    }),
    expected: [],
  },
];
