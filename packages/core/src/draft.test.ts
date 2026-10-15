import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  buildDraftRequest,
  findPlacementCandidates,
  inspectPdf,
  validateRequestAgainstPdf,
  type PlacementCandidate,
} from './index.ts';
import { fixturePdf } from './test-helpers.ts';

async function labelPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Signature:', { x: 72, y: 700, size: 12, font });
  page.drawText('Date:', { x: 72, y: 660, size: 12, font });
  return doc.save();
}

async function underscorePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Signature: ____________', { x: 72, y: 700, size: 12, font });
  page.drawText('Date: ________', { x: 72, y: 660, size: 12, font });
  return doc.save();
}

async function widgetPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Signature:', { x: 72, y: 700, size: 12, font });
  doc.getForm().createTextField('Full name').addToPage(page, { x: 72, y: 620, width: 180, height: 20, font });
  return doc.save();
}

async function draftAndValidate(pdf: Uint8Array, documentName: string) {
  const inspection = await inspectPdf(pdf, { rules: true });
  const { candidates } = findPlacementCandidates(inspection);
  const request = buildDraftRequest(inspection, candidates, { documentName });
  const { report } = await validateRequestAgainstPdf(pdf, request);
  expect(report.ok).toBe(true);
  expect(report.errors).toEqual([]);
  expect(report.warnings.filter((warning) => warning.code === 'anchor-ambiguous')).toEqual([]);
  expect(report.fields).toHaveLength(candidates.length);
  return { inspection, candidates, request, report };
}

describe('buildDraftRequest', () => {
  it.each([
    ['anchor labels', labelPdf],
    ['underscore lines', underscorePdf],
    ['AcroForm widgets', widgetPdf],
    ['shared fixture layout', fixturePdf],
  ])('turns %s candidates into a validate-clean request without hand-built fields', async (_name, makePdf) => {
    const { request } = await draftAndValidate(await makePdf(), 'synthetic.pdf');
    expect(request.fields.length).toBeGreaterThan(0);
    expect(request.fields.some((field) => field.type === 'signature')).toBe(true);
  });

  it('drafts the sample NDA from inspection and candidates in one call', async () => {
    const pdf = new Uint8Array(await readFile(new URL('../../web/public/sample-nda.pdf', import.meta.url)));
    const { candidates, request, report } = await draftAndValidate(pdf, 'sample-nda.pdf');

    expect(candidates.length).toBeGreaterThan(0);
    expect(request.document.sha256).toBe(report.sha256);
    expect(request.document.name).toBe('sample-nda.pdf');
  });

  it('is deterministic, keeps suggested placements, and applies values by candidate number or id', async () => {
    const pdf = await fixturePdf();
    const inspection = await inspectPdf(pdf, { rules: true });
    const { candidates } = findPlacementCandidates(inspection);
    const selected = candidates.findIndex((candidate) => candidate.suggested.type === 'text') + 1;
    const candidate = candidates[selected - 1]!;
    const options = { candidateNumbers: [selected], values: { [String(selected)]: 'Ada Example' }, title: 'Draft' };
    const first = buildDraftRequest(inspection, candidates, options);
    const second = buildDraftRequest(inspection, candidates, options);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.fields[0]).toMatchObject({
      id: candidate.text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      type: 'text',
      assignee: 'agent',
      value: 'Ada Example',
      placement: candidate.suggested.placement,
    });
    const { report } = await validateRequestAgainstPdf(pdf, first);
    expect(report.ok).toBe(true);
  });

  it('accepts generated field ids for values and assigns signer ids in candidate order', async () => {
    const pdf = await fixturePdf();
    const inspection = await inspectPdf(pdf, { rules: true });
    const { candidates } = findPlacementCandidates(inspection);
    const textCandidateNumber = candidates.findIndex((candidate) => candidate.suggested.type === 'text') + 1;
    const initial = buildDraftRequest(inspection, candidates, { candidateNumbers: [textCandidateNumber] });
    const withValue = buildDraftRequest(inspection, candidates, {
      candidateNumbers: [textCandidateNumber],
      values: { [initial.fields[0]!.id]: 'Ada Example' },
    });
    const withSigners = buildDraftRequest(inspection, candidates, {
      candidateNumbers: [1, 2],
      signers: [{ id: 'first' }, { id: 'second' }],
    });

    expect(withValue.fields[0]).toMatchObject({ assignee: 'agent', value: 'Ada Example' });
    expect(withSigners.fields.map((field) => field.signerId)).toEqual(['first', 'second']);
  });

  it('rejects a supplied value for a signature candidate with a code and actionable hint', async () => {
    const pdf = await labelPdf();
    const inspection = await inspectPdf(pdf);
    const { candidates } = findPlacementCandidates(inspection);
    const error = (() => {
      try {
        buildDraftRequest(inspection, candidates, { values: { '1': 'not a signature' } });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toMatchObject({
      code: 'invalid-argument',
      hint: expect.stringContaining('Only the human signer'),
    });
  });

  it('reports empty selections and unknown candidate numbers with hints', async () => {
    const pdf = await labelPdf();
    const inspection = await inspectPdf(pdf);
    const { candidates } = findPlacementCandidates(inspection);
    for (const candidateNumbers of [[], [candidates.length + 1]]) {
      expect(() => buildDraftRequest(inspection, candidates, { candidateNumbers })).toThrow(
        expect.objectContaining({ code: 'invalid-argument', hint: expect.any(String) }),
      );
    }
    expect(() => buildDraftRequest(inspection, [])).toThrow(
      expect.objectContaining({ code: 'invalid-argument', hint: expect.any(String) }),
    );
  });

  it('uses stable unique slugs for repeated candidate labels', async () => {
    const pdf = await labelPdf();
    const inspection = await inspectPdf(pdf);
    const { candidates } = findPlacementCandidates(inspection);
    const repeated = [candidates[0]!, candidates[0]!].map((candidate) => ({ ...candidate })) as PlacementCandidate[];
    const request = buildDraftRequest(inspection, repeated);
    expect(request.fields.map((field) => field.id)).toEqual(['signature', 'signature_2']);
  });
});
