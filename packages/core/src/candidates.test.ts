import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import type { FieldInput } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import {
  findCandidatesInPdf,
  findPlacementCandidates,
  inspectPdf,
  resolveRequest,
  type AcroFieldInfo,
  type PlacementCandidate,
} from './index.ts';
import { fixturePdf, requestFor } from './test-helpers.ts';

/** A synthetic form: labels, underscore lines, prose with colons and two form fields. */
async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const draw = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 12, font });
  draw('Signature:', 72, 700);
  draw('Signature:', 320, 700);
  draw('Name: ______________________', 72, 660);
  draw('Date: __________', 72, 620);
  draw('Initials: ______', 320, 620);
  draw('The parties agree to the terms below, in the order given here:', 72, 580);
  draw('Terms: see the schedule attached to this agreement.', 72, 560);
  draw('____________________', 72, 520);
  draw('Title: ______________________', 72, 440);
  const form = doc.getForm();
  form.createCheckBox('agree').addToPage(page, { x: 72, y: 480, width: 12, height: 12, borderWidth: 0 });
  // A form field drawn over the "Title" line: the widget is the better target.
  form.createTextField('title').addToPage(page, { x: 105, y: 436, width: 160, height: 18, borderWidth: 0 });
  return doc.save();
}

const summary = (candidate: PlacementCandidate) => [candidate.kind, candidate.text, candidate.suggested.type];

const bottom = (rect: { y: number; height: number }) => rect.y + rect.height;
const right = (rect: { x: number; width: number }) => rect.x + rect.width;

/** Resolve every candidate's suggested placement in one request; return the resolved rects in candidate order. */
async function resolveAll(pdf: Uint8Array, candidates: PlacementCandidate[]) {
  const fields: FieldInput[] = candidates.map((candidate, index) => ({
    id: `c${index + 1}`,
    type: candidate.suggested.type ?? 'text',
    assignee: 'human',
    placement: candidate.suggested.placement,
  }) as FieldInput);
  const resolved = await resolveRequest(pdf, await requestFor(pdf, fields));
  expect(resolved.warnings).toEqual([]);
  return resolved.fields.map((field) => field.rect);
}

/** The suggested placement lands where the candidate points: on the line, after the label, or on the widget. */
function expectLandsOnTarget(candidate: PlacementCandidate, rect: { page: number; x: number; y: number; width: number; height: number }) {
  expect(rect.page).toBe(candidate.page);
  if (candidate.kind === 'widget') {
    expect(rect).toMatchObject({ x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height });
  } else if (candidate.kind === 'line') {
    // The field sits on the underscores: it ends where they end and its bottom is the line's bottom.
    expect(right(rect)).toBeCloseTo(right(candidate), 1);
    expect(bottom(rect)).toBeCloseTo(bottom(candidate), 1);
  } else {
    // The field starts just after the label, centred on it.
    expect(rect.x).toBeCloseTo(right(candidate) + 4, 1);
    expect(rect.y + rect.height / 2).toBeCloseTo(candidate.y + candidate.height / 2, 1);
  }
}

describe('findPlacementCandidates', () => {
  it('finds labels, labelled lines, bare lines and widgets in reading order', async () => {
    const pdf = await formPdf();
    const { candidates, truncated, total } = findPlacementCandidates(await inspectPdf(pdf));
    expect(candidates.map(summary)).toEqual([
      ['label', 'Signature:', 'signature'],
      ['label', 'Signature:', 'signature'],
      ['line', 'Name:', 'text'],
      ['line', 'Date:', 'date'],
      ['line', 'Initials:', 'initials'],
      ['line', '____________________', undefined],
      ['widget', 'agree', 'checkbox'],
      ['widget', 'title', 'text'],
    ]);
    expect(truncated).toBe(false);
    expect(total).toBe(8);
    expect(candidates.every((candidate) => ['high', 'medium', 'low'].includes(candidate.confidence) && candidate.reason.length > 0)).toBe(true);
  });

  it('suggests readable anchors, with an occurrence only where the label repeats', async () => {
    const pdf = await formPdf();
    const { candidates } = findPlacementCandidates(await inspectPdf(pdf));
    expect(candidates.map((candidate) => candidate.suggested.placement)).toMatchObject([
      { kind: 'anchor', text: 'Signature:', page: 1, occurrence: 1, align: 'right', dx: 4, width: 150, height: 20 },
      { kind: 'anchor', text: 'Signature:', page: 1, occurrence: 2, align: 'right', dx: 4, width: 150, height: 20 },
      { kind: 'anchor', text: 'Name:', page: 1, align: 'right' },
      { kind: 'anchor', text: 'Date:', page: 1, align: 'right' },
      { kind: 'anchor', text: 'Initials:', page: 1, align: 'right' },
      { kind: 'rect', page: 1 },
      { kind: 'acroField', name: 'agree' },
      { kind: 'acroField', name: 'title' },
    ]);
    expect(candidates[2]?.suggested.placement).not.toHaveProperty('occurrence');
  });

  it('round-trips every suggested placement through resolveRequest onto its target', async () => {
    const pdf = await formPdf();
    const { candidates } = findPlacementCandidates(await inspectPdf(pdf));
    const rects = await resolveAll(pdf, candidates);
    candidates.forEach((candidate, index) => {
      const rect = rects[index];
      if (!rect) throw new Error(`candidate ${index + 1} did not resolve`);
      expectLandsOnTarget(candidate, rect);
    });
  });

  it('caps the result and says it was truncated', async () => {
    const inspection = await inspectPdf(await formPdf());
    const capped = findPlacementCandidates(inspection, { max: 3 });
    expect(capped.candidates.map((candidate) => candidate.text)).toEqual(['Signature:', 'Signature:', 'Name:']);
    expect(capped).toMatchObject({ truncated: true, total: 8 });
  });

  it('treats a NaN, infinite, negative or fractional max sensibly', async () => {
    const inspection = await inspectPdf(await formPdf());
    expect(findPlacementCandidates(inspection, { max: Number.NaN })).toMatchObject({ truncated: false, total: 8 });
    expect(findPlacementCandidates(inspection, { max: Number.POSITIVE_INFINITY }).candidates).toHaveLength(8);
    expect(findPlacementCandidates(inspection, { max: -3 })).toMatchObject({ candidates: [], truncated: true });
    expect(findPlacementCandidates(inspection, { max: 2.9 }).candidates).toHaveLength(2);
  });

  it('gives the same reading order whatever the input order, for staggered rects', () => {
    // a and b share a row, b and c would too, but a and c do not: a pairwise
    // "same row" test is not transitive, so order must come from grouping rows first.
    const widget = (name: string, x: number, y: number): AcroFieldInfo => ({
      name,
      type: 'text',
      readOnly: false,
      rect: { page: 1, x, y, width: 40, height: 20 },
    });
    const fields = [widget('a', 300, 100), widget('b', 200, 110), widget('c', 100, 120), widget('d', 50, 200)];
    const order = (acroFields: AcroFieldInfo[]) =>
      findPlacementCandidates({ pages: [{ page: 1, width: 612, height: 792 }], acroFields, text: [] }).candidates.map(
        (candidate) => candidate.text,
      );
    const forward = order(fields);
    expect(order([...fields].reverse())).toEqual(forward);
    expect(order([fields[1], fields[3], fields[0], fields[2]] as AcroFieldInfo[])).toEqual(forward);
    expect(forward).toEqual(['b', 'a', 'c', 'd']);
  });

  it('finds nothing without text or form fields', () => {
    expect(findPlacementCandidates({ pages: [{ page: 1, width: 612, height: 792 }], acroFields: [], text: [] })).toEqual({
      candidates: [],
      truncated: false,
      total: 0,
    });
  });

  it('groups a signature with nearby date and print-name fields, but not unrelated fields', () => {
    const widget = (name: string, type: AcroFieldInfo['type'], x: number, y: number): AcroFieldInfo => ({
      name,
      type,
      readOnly: false,
      rect: { page: 1, x, y, width: 80, height: 20 },
    });
    const { candidates } = findPlacementCandidates({
      pages: [{ page: 1, width: 612, height: 792 }],
      text: [],
      acroFields: [
        widget('Signature', 'signature', 72, 300),
        widget('Date', 'text', 160, 300),
        widget('Print Name', 'text', 72, 260),
        widget('Unrelated Date', 'text', 400, 500),
      ],
    });
    expect(candidates.slice(0, 3).map((candidate) => candidate.group)).toEqual([
      'sig-block-p1-1',
      'sig-block-p1-1',
      'sig-block-p1-1',
    ]);
    expect(candidates[3]).not.toHaveProperty('group');
    expect(candidates.every((candidate) => candidate.confidence === 'high' && candidate.reason.length > 0)).toBe(true);
  });
});

/**
 * A synthetic form whose blanks are drawn lines, laid out three ways: a label
 * that leads into its line, captions printed under their lines, and labels
 * heading a box whose bottom edge is the line. Display y = 792 - PDF y.
 */
async function drawnLinePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const draw = (text: string, x: number, y: number, size = 9) => page.drawText(text, { x, y, size, font });
  const line = (x0: number, x1: number, y: number) => page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: 0.5 });
  // Lead-in: the line starts just after the label (display y 100).
  draw('Your signature', 72, 692);
  line(140, 400, 692);
  draw('Date', 420, 692);
  line(445, 560, 692);
  // Captions under lines (display y 200), with an aside after the second one.
  draw('Paragraph text that ends well above the lines.', 72, 640);
  line(72, 300, 592);
  line(320, 540, 592);
  draw('Spouse\'s signature', 72, 584);
  draw('Date', 250, 584);
  draw('Initials', 320, 584);
  draw('(both must sign)', 356, 584, 6);
  // A box: a full-width border, labels at the top, the bottom edge 26 points below (display y 300 to 326).
  draw('More paragraph text just above the box border.', 72, 495);
  line(36, 576, 492);
  draw('Taxpayer\'s signature', 40, 482);
  draw('Date', 450, 482);
  line(36, 576, 466);
  page.drawLine({ start: { x: 445, y: 492 }, end: { x: 445, y: 466 }, thickness: 0.5 });
  return doc.save();
}

describe('drawn lines', () => {
  it('are found only when asked for', async () => {
    const pdf = await drawnLinePdf();
    expect((await inspectPdf(pdf)).rules).toEqual([]);
    const { rules } = await inspectPdf(pdf, { rules: true });
    // Six horizontal lines; the vertical divider is not one.
    expect(rules).toHaveLength(6);
    expect(rules.every((rule) => rule.height < 1 && rule.width >= 18)).toBe(true);
  });

  it('place a field on the line for a lead-in label, a caption and a box heading', async () => {
    const pdf = await drawnLinePdf();
    const { candidates } = findPlacementCandidates(await inspectPdf(pdf, { rules: true }));
    expect(candidates.map(summary)).toEqual([
      ['line', 'Your signature', 'signature'],
      ['line', 'Date', 'date'],
      ['line', 'Spouse\'s signature', 'signature'],
      ['line', 'Date', 'date'],
      ['line', 'Initials', 'initials'],
      ['line', 'Taxpayer\'s signature', 'signature'],
      ['line', 'Date', 'date'],
    ]);
    const rects = await resolveAll(pdf, candidates);
    const field = (index: number) => {
      const rect = rects[index];
      if (!rect) throw new Error(`candidate ${index + 1} did not resolve`);
      return { x: rect.x, right: right(rect), bottom: bottom(rect), height: rect.height };
    };
    const close = (actual: Record<string, number>, expected: Record<string, number>) =>
      Object.entries(expected).forEach(([key, value]) => expect(actual[key], key).toBeCloseTo(value, 0));
    // Lead-in: the field runs along the line after the label and sits on it.
    close(field(0), { x: 140, right: 400, bottom: 100, height: 20 });
    close(field(1), { x: 445, right: 560, bottom: 100, height: 14 });
    // Captions: each takes its part of the line above it; the aside does not cut the field short.
    close(field(2), { x: 72, right: 246, bottom: 200, height: 20 });
    close(field(3), { x: 248, right: 300, bottom: 200, height: 14 });
    close(field(4), { x: 320, right: 540, bottom: 200, height: 20 });
    // Box: the full-width border above is not a caption's line; the field fills the box under the labels.
    expect(field(5).bottom).toBeCloseTo(326, 0);
    expect(field(5).height).toBeGreaterThanOrEqual(10);
    expect(field(5).right).toBeCloseTo(446, 0);
    expect(field(6).bottom).toBeCloseTo(326, 0);
  });

  it('put the field inside a small box the label heads, not on its top edge', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawRectangle({ x: 72, y: 300, width: 200, height: 50, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    page.drawText('Date', { x: 76, y: 338, size: 10, font });
    const pdf = await doc.save();
    const { candidates } = findPlacementCandidates(await inspectPdf(pdf, { rules: true }));
    expect(candidates.map(summary)).toEqual([['line', 'Date', 'date']]);
    const [rect] = await resolveAll(pdf, candidates);
    // The box spans display y 442 to 492; the field rests on its bottom edge.
    expect(bottom(rect!)).toBeCloseTo(492, 0);
  });

  it('ignore the borders of form field widgets', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    doc.getForm().createTextField('name').addToPage(page, { x: 300, y: 500, width: 200, height: 20, borderWidth: 1 });
    expect((await inspectPdf(await doc.save(), { rules: true })).rules).toEqual([]);
  });

  it('add nothing where a typed label or underscore line already marks the blank', async () => {
    const inspection = await inspectPdf(await formPdf(), { rules: true });
    expect(findPlacementCandidates(inspection).candidates.map(summary)).toEqual(
      findPlacementCandidates({ ...inspection, rules: [] }).candidates.map(summary),
    );
  });
});

describe('the sample NDA', () => {
  it('finds both signature lines and the date and name fields, and each suggestion lands on its target', async () => {
    const pdf = new Uint8Array(await readFile(new URL('../../web/public/sample-nda.pdf', import.meta.url)));
    const { candidates } = findPlacementCandidates(await inspectPdf(pdf));
    const page3 = candidates.filter((candidate) => candidate.page === 3);
    expect(page3.map(summary)).toEqual([
      ['line', 'Party A’s Signature', 'signature'],
      ['widget', 'Date', 'date'],
      ['widget', 'Print Name', 'text'],
      ['line', 'Party B’s Signature', 'signature'],
      ['widget', 'Date_2', 'date'],
      ['widget', 'Print Name_2', 'text'],
    ]);
    expect(page3[0]?.suggested.placement).toMatchObject({ kind: 'anchor', text: 'Party A’s Signature', align: 'right' });
    // The "Date ____" and "Print Name ____" lines sit under form fields, so only the fields are listed.
    expect(candidates.filter((candidate) => candidate.kind === 'line' && candidate.page !== 3)).toEqual([]);
    expect(candidates.every((candidate) => candidate.confidence && candidate.reason.length > 0)).toBe(true);

    const rects = await resolveAll(pdf, candidates);
    candidates.forEach((candidate, index) => {
      const rect = rects[index];
      if (!rect) throw new Error(`candidate ${index + 1} did not resolve`);
      expectLandsOnTarget(candidate, rect);
    });
    // The signature line "__________________________" starts at x 185.8 on the line at y 102.53.
    expect(rects[candidates.indexOf(page3[0] as PlacementCandidate)]?.x).toBeCloseTo(185.8, 0);
  });
});

describe('findCandidatesInPdf', () => {
  it('inspects the PDF, caps the candidates at max and says so', async () => {
    const pdf = await fixturePdf();
    const all = await findCandidatesInPdf(pdf);
    expect(all).toMatchObject({ pages: [{ page: 1, width: 612, height: 792 }], truncated: false, total: 3 });
    expect(all.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(all.candidates.map((candidate) => [candidate.kind, candidate.text])).toEqual([
      ['widget', 'full_name'],
      ['label', 'Signature:'],
      ['label', 'Date:'],
    ]);
    const one = await findCandidatesInPdf(pdf, { max: 1 });
    expect(one).toMatchObject({ truncated: true, total: 3 });
    expect(one.candidates).toHaveLength(1);
  });

  it('refuses a max that is not a whole number of at least 1, with invalid-argument', async () => {
    const pdf = await fixturePdf();
    for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(findCandidatesInPdf(pdf, { max }), String(max)).rejects.toMatchObject({
        code: 'invalid-argument',
        hint: 'Pass max as a whole number of at least 1.',
      });
    }
  });
});
