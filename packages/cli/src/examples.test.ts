/**
 * The request examples in `examples/` must stay valid for the PDFs they name.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { sha256Hex } from '@sign-pdf/core';
import { describe, expect, it } from 'vitest';
import { runCli, workspace } from './test-helpers.ts';
import type { ValidationReport } from '@sign-pdf/core';

const SAMPLE_PDF = fileURLToPath(new URL('../../web/public/sample-nda.pdf', import.meta.url));
const SAMPLE_REQUEST = fileURLToPath(new URL('../examples/sample-nda.request.json', import.meta.url));
const SAMPLE_DRAFT = fileURLToPath(new URL('../examples/sample-nda.draft.json', import.meta.url));
const MULTI_SIGNER_REQUEST = fileURLToPath(new URL('../examples/multi-signer.request.json', import.meta.url));
const ANCHOR_ONLY_REQUEST = fileURLToPath(new URL('../examples/anchor-only.request.json', import.meta.url));
const SYNTHETIC_PDF_SHA256 = '77224425c119d291daa4e9e64ad0ef40d8973b182238004e8bf5da5dd9b64bbb';

interface ExampleRequest {
  document: { sha256: string };
  signers?: Array<{ id: string; name?: string }>;
  fields: Array<{ id: string; type: string; assignee: string; value?: unknown; placement: { kind: string } }>;
}

async function syntheticAnchorPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const fixedDate = new Date('2026-01-01T00:00:00.000Z');
  document.setCreationDate(fixedDate);
  document.setModificationDate(fixedDate);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText('Accepted terms:', { x: 72, y: 710, size: 12, font });
  page.drawText('First signer:', { x: 72, y: 620, size: 12, font });
  page.drawText('Second signer:', { x: 72, y: 530, size: 12, font });
  return document.save();
}

async function readExample(path: string): Promise<ExampleRequest> {
  return JSON.parse(await readFile(path, 'utf8')) as ExampleRequest;
}

describe('CLI request examples', () => {
  it('keeps the worked draft example identical to the generated sample NDA request', async () => {
    const example = await readExample(SAMPLE_DRAFT);
    expect(example.document.sha256).toBe(await sha256Hex(new Uint8Array(await readFile(SAMPLE_PDF))));

    const generated = await runCli(['draft', SAMPLE_PDF, '--candidates', '4,5,8-10', '--json']);
    expect(generated.stderr).toBe('');
    expect(generated.code).toBe(0);
    expect(generated.json<{ request: ExampleRequest; skipped: unknown[] }>().request).toEqual(example);
    expect(generated.json<{ skipped: Array<{ number: number; reason: string }> }>().skipped).toEqual(
      [1, 2, 3, 6, 7, 11, 12, 13].map((number) => ({ number, reason: 'not_selected' })),
    );

    const validation = await runCli(['validate', SAMPLE_PDF, SAMPLE_DRAFT, '--json']);
    expect(validation.stderr).toBe('');
    expect(validation.code).toBe(0);
    const report = validation.json<ValidationReport>();
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.filter((warning) => warning.code === 'anchor-ambiguous')).toEqual([]);
  });

  it('validates against the sample NDA with no errors or warnings', async () => {
    const result = await runCli(['validate', SAMPLE_PDF, SAMPLE_REQUEST, '--json']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const report = result.json<ValidationReport>();
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);

    const example = await readExample(SAMPLE_REQUEST);
    expect(report.fields.map((field) => field.id)).toEqual(example.fields.map((field) => field.id));
    // Every field resolved to a box with a real size on a page of the document.
    for (const field of report.fields) {
      expect(field.rect.page).toBeGreaterThanOrEqual(1);
      expect(field.rect.page).toBeLessThanOrEqual(report.pages.length);
      expect(field.rect.width).toBeGreaterThan(0);
      expect(field.rect.height).toBeGreaterThan(0);
    }
  });

  it('names the sample NDA by its hash and shows the recommended placements', async () => {
    const example = await readExample(SAMPLE_REQUEST);
    expect(example.document.sha256).toBe(await sha256Hex(new Uint8Array(await readFile(SAMPLE_PDF))));
    // The example teaches anchors and existing form fields, not guessed rectangles.
    const kinds = new Set(example.fields.map((field) => field.placement.kind));
    expect(kinds).toEqual(new Set(['anchor', 'acroField']));
    // The signature is the human's and carries no value.
    const signature = example.fields.filter((field) => field.type === 'signature');
    expect(signature).toHaveLength(1);
    expect(signature[0]).toMatchObject({ assignee: 'human' });
    expect(signature[0]).not.toHaveProperty('value');
  });

  it('validates the multi-signer request against its synthetic PDF', async () => {
    const temp = await workspace();
    try {
      const pdf = await syntheticAnchorPdf();
      const pdfPath = await temp.write('synthetic-anchor-form.pdf', pdf);
      const example = await readExample(MULTI_SIGNER_REQUEST);
      expect(example.document.sha256).toBe(SYNTHETIC_PDF_SHA256);
      expect(example.document.sha256).toBe(await sha256Hex(pdf));
      expect(example.signers).toEqual([
        { id: 'first', name: 'Signer One' },
        { id: 'second', name: 'Signer Two' },
      ]);

      const result = await runCli(['validate', pdfPath, MULTI_SIGNER_REQUEST, '--json']);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const report = result.json<ValidationReport>();
      expect(report.ok).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.fields.map((field) => field.id)).toEqual(['first_signature', 'second_signature']);
    } finally {
      await temp.cleanup();
    }
  });

  it('validates the anchor-only checkbox request on a PDF with no AcroForm fields', async () => {
    const temp = await workspace();
    try {
      const pdf = await syntheticAnchorPdf();
      const pdfPath = await temp.write('synthetic-anchor-form.pdf', pdf);
      const example = await readExample(ANCHOR_ONLY_REQUEST);
      expect(example.document.sha256).toBe(SYNTHETIC_PDF_SHA256);
      expect(example.document.sha256).toBe(await sha256Hex(pdf));
      expect(example.fields.find((field) => field.type === 'checkbox')).toMatchObject({
        assignee: 'human',
        placement: { kind: 'anchor' },
      });

      const inspection = await runCli(['inspect', pdfPath, '--json']);
      expect(inspection.code).toBe(0);
      expect(inspection.json<{ acroFields: unknown[] }>().acroFields).toEqual([]);

      const result = await runCli(['validate', pdfPath, ANCHOR_ONLY_REQUEST, '--json']);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const report = result.json<ValidationReport>();
      expect(report.ok).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.fields.map((field) => field.id)).toEqual(['accept_terms', 'signature']);
    } finally {
      await temp.cleanup();
    }
  });
});
