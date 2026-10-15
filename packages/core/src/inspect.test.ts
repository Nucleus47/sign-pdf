import { readFile } from 'node:fs/promises';
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SignPdfError,
  configurePdfjs,
  findCandidatesInPdf,
  inspectPdf,
  resolveRequest,
  sha256Hex,
  type PdfjsLike,
} from './index.ts';
import { makePng, requestFor } from './test-helpers.ts';

async function buildDocument() {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  const first = doc.addPage([612, 792]);
  first.drawText('Signature:', { x: 72, y: 692, size: 12, font: helvetica });
  const name = form.createTextField('applicant.name');
  name.addToPage(first, { x: 72, y: 600, width: 200, height: 20, borderWidth: 0 });
  name.setText('Ada Example');
  const agree = form.createCheckBox('agree');
  agree.addToPage(first, { x: 72, y: 560, width: 14, height: 14, borderWidth: 0 });
  agree.check();

  // Stored 400 x 600, shown turned a quarter clockwise: 600 x 400.
  const rotated = doc.addPage([400, 600]);
  rotated.setRotation(degrees(90));
  rotated.drawText('Rotated label', { x: 100, y: 200, size: 10, font: helvetica, rotate: degrees(90) });

  // Only the region x 50..450, y 100..700 is shown.
  const cropped = doc.addPage([612, 792]);
  cropped.setCropBox(50, 100, 400, 600);
  cropped.drawText('Cropped', { x: 72, y: 600, size: 12, font: helvetica });
  const locked = form.createTextField('locked');
  locked.addToPage(cropped, { x: 100, y: 300, width: 120, height: 18, borderWidth: 0 });
  locked.enableReadOnly();

  return {
    pdf: await doc.save(),
    widths: {
      signature: helvetica.widthOfTextAtSize('Signature:', 12),
      rotated: helvetica.widthOfTextAtSize('Rotated label', 10),
    },
  };
}

async function buildImageDocument(options: { mixed?: boolean; dashArray?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(makePng(2, 2));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([612, 792]);
  if (options.mixed) first.drawText('Signature:', { x: 72, y: 692, size: 12, font });
  first.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  if (options.dashArray) {
    const dash = PDFArray.withContext(doc.context);
    dash.push(PDFNumber.of(1));
    dash.push(PDFNumber.of(2));
    first.pushOperators(
      PDFOperator.of(PDFOperatorNames.SetLineDashPattern, [dash, '0']),
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('Span'), '<< /MCID 1 >>']),
    );
  }
  if (options.mixed) {
    const second = doc.addPage([612, 792]);
    second.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  }
  return doc.save();
}

afterEach(() => configurePdfjs(undefined));

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('inspectPdf', () => {
  it('reports displayed page sizes, applying rotation and the crop box', async () => {
    const { pdf } = await buildDocument();
    const inspection = await inspectPdf(pdf);
    expect(inspection.sha256).toBe(await sha256Hex(pdf));
    expect(inspection.pages.map(({ page, width, height }) => ({ page, width, height }))).toEqual([
      { page: 1, width: 612, height: 792 },
      { page: 2, width: 600, height: 400 },
      { page: 3, width: 400, height: 600 },
    ]);
  });

  it('positions text runs from the top-left of the displayed page', async () => {
    const { pdf, widths } = await buildDocument();
    const { text } = await inspectPdf(pdf);

    const signature = text.find((item) => item.text === 'Signature:');
    expect(signature).toMatchObject({ page: 1 });
    expect(signature?.x).toBeCloseTo(72, 1);
    expect(signature?.y).toBeCloseTo(792 - 692 - 12, 1);
    expect(signature?.width).toBeCloseTo(widths.signature, 1);
    expect(signature?.height).toBeCloseTo(12, 1);

    // Native baseline start (100, 200) on a page rotated 90: displayed at x 200, baseline y 100.
    const rotated = text.find((item) => item.text === 'Rotated label');
    expect(rotated).toMatchObject({ page: 2 });
    expect(rotated?.x).toBeCloseTo(200, 1);
    expect(rotated?.y).toBeCloseTo(90, 1);
    expect(rotated?.width).toBeCloseTo(widths.rotated, 1);
    expect(rotated?.height).toBeCloseTo(10, 1);

    // Crop box origin (50, 100), top edge at native y 700.
    const cropped = text.find((item) => item.text === 'Cropped');
    expect(cropped).toMatchObject({ page: 3 });
    expect(cropped?.x).toBeCloseTo(72 - 50, 1);
    expect(cropped?.y).toBeCloseTo(700 - 600 - 12, 1);
  });

  it('lists form fields with qualified names, types, rects, values and the read-only flag', async () => {
    const { pdf } = await buildDocument();
    const { acroFields } = await inspectPdf(pdf, { text: false });
    expect(acroFields).toEqual([
      {
        name: 'applicant.name',
        type: 'text',
        readOnly: false,
        value: 'Ada Example',
        rect: { page: 1, x: 72, y: 792 - 600 - 20, width: 200, height: 20 },
      },
      {
        name: 'agree',
        type: 'checkbox',
        readOnly: false,
        value: true,
        rect: { page: 1, x: 72, y: 792 - 560 - 14, width: 14, height: 14 },
      },
      {
        name: 'locked',
        type: 'text',
        readOnly: true,
        rect: { page: 3, x: 50, y: 700 - 300 - 18, width: 120, height: 18 },
      },
    ]);
  });

  it('skips text extraction when asked', async () => {
    const { pdf } = await buildDocument();
    expect((await inspectPdf(pdf, { text: false })).text).toEqual([]);
  });

  it('uses the pdf.js module given to configurePdfjs', async () => {
    const { pdf } = await buildDocument();
    let destroyed = false;
    const fake: PdfjsLike = {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 3,
          getPage: async () => ({
            getTextContent: async () => ({
              items: [{ type: 'beginMarkedContent' }, { str: 'Injected', transform: [10, 0, 0, 10, 20, 30], width: 40, height: 10 }],
            }),
          }),
        }),
        destroy: async () => {
          destroyed = true;
        },
      }),
    };
    configurePdfjs(fake);
    const { text } = await inspectPdf(pdf);
    expect(text).toHaveLength(3);
    expect(text[0]).toEqual({ page: 1, text: 'Injected', x: 20, y: 792 - 30 - 10, width: 40, height: 10 });
    expect(destroyed).toBe(true);
  });

  it('diagnoses a page with a painted image XObject and no usable text', async () => {
    const pdf = await buildImageDocument();
    const inspection = await inspectPdf(pdf);
    expect(inspection.pages).toEqual([
      { page: 1, width: 612, height: 792, textRunCount: 0, hasText: false, imageOnly: true },
    ]);
    expect(inspection.imageOnlyPages).toEqual([1]);
    expect(inspection.warnings).toEqual([
      {
        code: 'image-only-page',
        hint: expect.stringContaining('Anchors and candidates cannot work'),
      },
    ]);

    const candidates = await findCandidatesInPdf(pdf);
    expect(candidates.candidates).toEqual([]);
    expect(candidates.warnings).toEqual(inspection.warnings);
    expect(candidates.warnings[0]?.hint).toContain('render_preview on the bare page');
    expect(candidates.warnings[0]?.hint).toContain('explicit rect placements');
  });

  it('completes inspection when a painted image page has an array-valued dash operator', async () => {
    const pdf = await buildImageDocument({ dashArray: true });
    const inspection = await inspectPdf(pdf);
    expect(inspection.imageOnlyPages).toEqual([1]);
  });

  it('flags only the image page in a mixed PDF and still resolves a text-page anchor', async () => {
    const pdf = await buildImageDocument({ mixed: true });
    const inspection = await inspectPdf(pdf);
    expect(inspection.pages.map(({ textRunCount, hasText, imageOnly }) => ({ textRunCount, hasText, imageOnly }))).toEqual([
      { textRunCount: 1, hasText: true, imageOnly: false },
      { textRunCount: 0, hasText: false, imageOnly: true },
    ]);
    expect(inspection.imageOnlyPages).toEqual([2]);
    const request = await requestFor(pdf, [
      { id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'anchor', text: 'Signature:', page: 1, width: 120, height: 24 } },
    ]);
    expect((await resolveRequest(pdf, request)).fields[0]?.rect.page).toBe(1);
  });

  it('keeps summary mode lean and preserves the sample NDA anchors and field names', async () => {
    const sample = new Uint8Array(await readFile(new URL('../../web/public/sample-nda.pdf', import.meta.url)));
    const full = await inspectPdf(sample);
    const summary = await inspectPdf(sample, { detail: 'summary' });
    const fullBytes = new TextEncoder().encode(JSON.stringify(full)).length;
    const summaryBytes = new TextEncoder().encode(JSON.stringify(summary)).length;
    expect(summaryBytes).toBeLessThanOrEqual(fullBytes * 0.25);
    const searchable = [
      ...summary.textLines.map((line) => line.text),
      ...summary.acroFields.map((field) => field.name.toLowerCase()),
    ].join('\n');
    for (const anchor of ['hereinafter known as', 'hereinafter known as party b', 'party a’s signature', 'date', 'print name']) {
      expect(searchable).toContain(anchor);
    }
  });

  it('preserves the full-mode legacy inspection payload alongside additive diagnosis', async () => {
    const { pdf } = await buildDocument();
    const inspection = await inspectPdf(pdf);
    const legacyPayload = {
      sha256: inspection.sha256,
      pages: inspection.pages.map(({ page, width, height }) => ({ page, width, height })),
      acroFields: inspection.acroFields,
      text: inspection.text,
      rules: inspection.rules,
    };
    expect(JSON.stringify(legacyPayload)).toBe(
      JSON.stringify({
        sha256: await sha256Hex(pdf),
        pages: [
          { page: 1, width: 612, height: 792 },
          { page: 2, width: 600, height: 400 },
          { page: 3, width: 400, height: 600 },
        ],
        acroFields: [
          { name: 'applicant.name', type: 'text', readOnly: false, rect: { page: 1, x: 72, y: 172, width: 200, height: 20 }, value: 'Ada Example' },
          { name: 'agree', type: 'checkbox', readOnly: false, rect: { page: 1, x: 72, y: 218, width: 14, height: 14 }, value: true },
          { name: 'locked', type: 'text', readOnly: true, rect: { page: 3, x: 50, y: 382, width: 120, height: 18 } },
        ],
        text: [
          { page: 1, x: 72, y: 88, width: 54.696, height: 12, text: 'Signature:' },
          { page: 2, x: 200, y: 90, width: 58.91999999999996, height: 10, text: 'Rotated label' },
          { page: 3, x: 22, y: 88, width: 46.019999999999996, height: 12, text: 'Cropped' },
        ],
        rules: [],
      }),
    );
  });

  it('rejects an encrypted PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.encrypt({ userPassword: 'synthetic-user', ownerPassword: 'synthetic-owner' });
    const error = await inspectPdf(await doc.save()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignPdfError);
    expect((error as SignPdfError).code).toBe('encrypted-pdf');
  });

  it('rejects bytes that are not a PDF', async () => {
    const error = await inspectPdf(new TextEncoder().encode('this is not a pdf')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignPdfError);
    expect((error as SignPdfError).code).toBe('invalid-pdf');
  });
});
