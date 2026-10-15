/**
 * Anchor matches are ranked (exact run, whole word, substring) and
 * `occurrence` counts within the best rank. A choice among several matches the
 * request did not make is reported as an 'anchor-ambiguous' warning.
 */
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import type { FieldInput, PlacementInput } from '@sign-pdf/spec';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveRequest, resolveRequestCollect, type TextItem } from './index.ts';
import { MAX_ANCHOR_CANDIDATES, bestAnchorMatches, findAnchorMatches } from './resolve.ts';
import { requestFor } from './test-helpers.ts';

const run = (text: string, x: number, y = 100, page = 1): TextItem => ({
  page,
  x,
  y,
  width: text.length * 6,
  height: 12,
  text,
});

const best = (items: TextItem[], needle: string) => bestAnchorMatches(findAnchorMatches(items, needle));

describe('anchor match ranking', () => {
  it('prefers a run that is exactly the anchor text over a word inside a line', () => {
    const items = [run('Sign on the date shown. Date of birth', 72, 50), run('  DATE ', 72)];
    const all = findAnchorMatches(items, 'date');
    expect(all.map((match) => [match.rank, match.text])).toEqual([
      ['word', 'date'],
      ['word', 'Date'],
      ['exact', 'DATE'],
    ]);
    expect(best(items, 'date').map((match) => match.y)).toEqual([100]);
  });

  it('prefers a whole word over a substring of a longer word', () => {
    const items = [run('Mandated updates', 72, 50), run('Update the Date line', 72)];
    const matches = best(items, 'Date');
    expect(matches.map((match) => [match.rank, match.text, match.y])).toEqual([['word', 'Date', 100]]);
  });

  it('falls back to substrings and reports the whole word each one sits in', () => {
    const matches = best([run('Mandated updates', 72)], 'date');
    expect(matches.map((match) => [match.rank, match.text])).toEqual([
      ['substring', 'Mandated'],
      ['substring', 'updates'],
    ]);
  });

  it('treats punctuation at either end of the anchor as its own boundary', () => {
    // "Name:" ends in a colon, so "Name:Ada" still counts as a whole-word match.
    const matches = best([run('Surname: Smith', 72, 50), run('Name:Ada', 72)], 'Name:');
    expect(matches.map((match) => [match.rank, match.y])).toEqual([['word', 100]]);
  });

  it('finds word boundaries in Greek and Cyrillic text', () => {
    const greek = best([run('Ημερομηνίες ισχύος', 72, 50), run('Υπογραφή και Ημερομηνία', 72)], 'ημερομηνία');
    expect(greek.map((match) => [match.rank, match.text])).toEqual([['word', 'Ημερομηνία']]);
    const cyrillic = best([run('Датами подписания', 72, 50), run('Подпись и дата', 72)], 'Дата');
    expect(cyrillic.map((match) => [match.rank, match.text])).toEqual([['word', 'дата']]);
    const accented = best([run('Pièce signée', 72, 50), run('Signé le', 72)], 'signé');
    expect(accented.map((match) => [match.rank, match.text])).toEqual([['word', 'Signé']]);
  });

  it('keeps reading order within a rank, across pages', () => {
    const items = [run('Initials', 300, 100, 2), run('Initials', 72, 100, 1), run('Initials', 72, 100, 2)];
    expect(best(items, 'Initials').map((match) => [match.page, match.x])).toEqual([
      [1, 72],
      [2, 72],
      [2, 300],
    ]);
  });
});

describe('anchor-ambiguous warnings', () => {
  let pdf: Uint8Array;

  beforeAll(async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Both parties sign on the dates shown below.', { x: 72, y: 700, size: 12, font });
    page.drawText('Date', { x: 72, y: 650, size: 12, font });
    page.drawText('Date', { x: 300, y: 650, size: 12, font });
    page.drawText('Witness', { x: 72, y: 600, size: 12, font });
    pdf = await doc.save();
  });

  const date = (id: string, placement: Partial<PlacementInput> = {}): FieldInput => ({
    id,
    type: 'date',
    assignee: 'human',
    placement: { kind: 'anchor', text: 'Date', width: 100, height: 14, ...placement } as PlacementInput,
  });

  it('uses the first best match and lists every candidate when the request gave no occurrence', async () => {
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [date('when')]));
    expect(resolved.fields[0]?.rect.x).toBeLessThan(300);
    expect(resolved.warnings).toHaveLength(1);
    const [warning] = resolved.warnings;
    expect(warning).toMatchObject({ code: 'anchor-ambiguous', fieldId: 'when', rank: 'exact' });
    expect(warning?.message).toContain('2 exact matches');
    expect(warning?.candidates.map((candidate) => [candidate.text, candidate.page, Math.round(candidate.x)])).toEqual([
      ['Date', 1, 72],
      ['Date', 1, 300],
    ]);
    for (const candidate of warning?.candidates ?? []) {
      expect(candidate.y).toBeCloseTo(792 - 650 - 12, 0);
      expect(candidate.width).toBeGreaterThan(0);
    }
  });

  it('lists at most MAX_ANCHOR_CANDIDATES candidates and gives the full count in the message', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    for (let row = 0; row < MAX_ANCHOR_CANDIDATES + 5; row += 1) page.drawText('Date', { x: 72, y: 760 - row * 24, size: 12, font });
    const many = await doc.save();
    const resolved = await resolveRequest(many, await requestFor(many, [date('when')]));
    expect(resolved.warnings[0]?.candidates).toHaveLength(MAX_ANCHOR_CANDIDATES);
    expect(resolved.warnings[0]?.message).toContain(`${MAX_ANCHOR_CANDIDATES + 5} exact matches`);
  });

  it('gives no warning when the request names the occurrence, even occurrence 1', async () => {
    const second = await resolveRequest(pdf, await requestFor(pdf, [date('when', { occurrence: 2 })]));
    expect(second.fields[0]?.rect.x).toBeGreaterThan(300);
    expect(second.warnings).toEqual([]);
    const first = await resolveRequest(pdf, await requestFor(pdf, [date('when', { occurrence: 1 })]));
    expect(first.warnings).toEqual([]);
  });

  it('gives no warning for a single match', async () => {
    const witness = date('witness', { text: 'Witness' } as Partial<PlacementInput>);
    expect((await resolveRequest(pdf, await requestFor(pdf, [witness]))).warnings).toEqual([]);
  });

  it('counts occurrence within the best rank, so the prose "dates" is never a candidate', async () => {
    const error = await resolveRequest(pdf, await requestFor(pdf, [date('when', { occurrence: 3 })])).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'anchor-not-found', fieldId: 'when' });
    expect((error as Error).message).toContain('2 exact match(es)');
  });

  it('reports warnings from resolveRequestCollect, also when another field fails', async () => {
    const report = await resolveRequestCollect(
      pdf,
      await requestFor(pdf, [date('when'), date('lost', { text: 'Not here' } as Partial<PlacementInput>)]),
    );
    expect(report.errors.map((error) => error.fieldId)).toEqual(['lost']);
    expect(report.warnings.map((warning) => warning.fieldId)).toEqual(['when']);
  });
});

describe('the sample NDA (regression for issue #7)', () => {
  it('places an anchor of "Date" on page 3 at the Date label, not at "dates" in the prose', async () => {
    const pdf = new Uint8Array(await readFile(new URL('../../web/public/sample-nda.pdf', import.meta.url)));
    const field: FieldInput = {
      id: 'date',
      type: 'date',
      assignee: 'human',
      placement: { kind: 'anchor', text: 'Date', page: 3, align: 'over', width: 30, height: 12 },
    };
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [field]));
    // The first "Date _________________" label starts at x 363.15 on the line at y 102.53.
    // The prose line "... on the dates indicated." is at y 61.03.
    const rect = resolved.fields[0]?.rect;
    expect(rect?.page).toBe(3);
    expect(rect?.x).toBeCloseTo(363.15, 0);
    expect(rect?.y).toBeCloseTo(102.53, 0);
    // The label appears for both parties, so the choice is reported.
    expect(resolved.warnings[0]?.candidates.map((candidate) => [candidate.text, Math.round(candidate.y)])).toEqual([
      ['Date', 103],
      ['Date', 199],
    ]);
  });
});
