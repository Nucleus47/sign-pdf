import { readFile, readdir } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { FIELD_COLORS, PLACEMENT_CANDIDATE_COLOR, RULER_LEFT, RULER_TOP, findPlacementCandidates, inspectPdf, resolveRequest } from '@sign-pdf/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePageList, renderPreview } from './preview.ts';
import { fixturePdf, rect, requestFor, runCli, workspace, type Workspace } from './test-helpers.ts';

type Rgb = readonly [number, number, number];

/** Decode a PNG and return a pixel reader. */
async function pixels(png: Uint8Array): Promise<{ width: number; height: number; at(x: number, y: number): Rgb }> {
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  return {
    width: image.width,
    height: image.height,
    at: (x, y) => {
      const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
      return [data[offset] ?? -1, data[offset + 1] ?? -1, data[offset + 2] ?? -1];
    },
  };
}

function expectColor(actual: Rgb, expected: Rgb, tolerance = 12): void {
  for (const channel of [0, 1, 2] as const) {
    expect(Math.abs(actual[channel] - expected[channel]), `channel ${channel} of ${actual.join(',')}`).toBeLessThanOrEqual(tolerance);
  }
}

const WHITE: Rgb = [255, 255, 255];
// Positions chosen off the 50-point grid lines.
const BOX = rect(1, 110, 220, 120, 40);

let ws: Workspace;
let pdf: Uint8Array;

beforeEach(async () => {
  ws = await workspace();
  pdf = await fixturePdf({ pages: 3 });
});

afterEach(async () => {
  await ws.cleanup();
});

describe('renderPreview', () => {
  it('renders each page that has fields, at the page size times the scale plus the rulers', async () => {
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [
        { id: 'sig', type: 'signature', assignee: 'human', placement: BOX },
        { id: 'init', type: 'initials', assignee: 'human', placement: rect(3, 60, 60, 40, 20) },
      ]),
    );
    const pages = await renderPreview(pdf, resolved, { scale: 2 });
    expect(pages.map((page) => page.page)).toEqual([1, 3]);
    for (const page of pages) {
      expect(page).toMatchObject({
        width: RULER_LEFT + 612 * 2,
        height: RULER_TOP + 792 * 2,
        scale: 2,
        origin: { x: RULER_LEFT, y: RULER_TOP },
        pageWidth: 612,
        pageHeight: 792,
      });
      // PNG signature.
      expect([...page.png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const image = await pixels(page.png);
      expect([image.width, image.height]).toEqual([page.width, page.height]);
    }
    expect(pages[0]?.fieldIds).toEqual(['sig']);
    expect(pages[1]?.fieldIds).toEqual(['init']);
  });

  it('draws each field box where its rectangle is, in the colour of its type', async () => {
    const scale = 2;
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: BOX }]));
    const [page] = await renderPreview(pdf, resolved, { scale });
    if (!page) throw new Error('no page rendered');
    const image = await pixels(page.png);
    const px = (x: number) => page.origin.x + x * scale;
    const py = (y: number) => page.origin.y + y * scale;
    const midX = BOX.x + BOX.width / 2;
    const midY = BOX.y + BOX.height / 2;
    const color = FIELD_COLORS.signature;

    // The outline runs along all four edges of the rectangle.
    expectColor(image.at(px(BOX.x), py(midY)), color);
    expectColor(image.at(px(BOX.x + BOX.width), py(midY)), color);
    expectColor(image.at(px(midX), py(BOX.y)), color);
    expectColor(image.at(px(midX), py(BOX.y + BOX.height)), color);

    // Inside: a light tint of the same colour, so the page stays readable.
    const inside = image.at(px(midX), py(midY));
    expect(inside[0]).toBeGreaterThan(230);
    expect(inside[1]).toBeLessThan(240);
    expect(inside[1]).toBeGreaterThan(180);

    // Just outside the box, and far from it, the page is untouched.
    expectColor(image.at(px(BOX.x - 6), py(midY)), WHITE);
    expectColor(image.at(px(BOX.x + BOX.width + 6), py(midY)), WHITE);
    expectColor(image.at(px(430), py(430)), WHITE);

    // The label tag sits above the box, in the field's colour.
    const tagRow = Array.from({ length: 30 }, (_, i) => image.at(px(BOX.x) + 2 + i, py(BOX.y) - 9));
    expect(tagRow.some((pixel) => Math.abs(pixel[0] - color[0]) < 12 && Math.abs(pixel[2] - color[2]) < 12)).toBe(true);
  });

  it('draws the box where the rectangle is on a page with /Rotate 90', async () => {
    const scale = 2;
    const rotated = await fixturePdf({ rotate: 90 });
    // The page is 612 x 792 in the file and is displayed turned: 792 wide, 612 high.
    // The box could not be here on an unrotated page: its right edge is beyond 612.
    // Its edges and its middle are off the 50-point grid lines.
    const box = rect(1, 630, 120, 130, 64);
    const resolved = await resolveRequest(rotated, await requestFor(rotated, [{ id: 'sig', type: 'signature', assignee: 'human', placement: box }]));
    const [page] = await renderPreview(rotated, resolved, { scale });
    if (!page) throw new Error('no page rendered');
    expect(page).toMatchObject({ pageWidth: 792, pageHeight: 612, width: RULER_LEFT + 792 * scale, height: RULER_TOP + 612 * scale });
    const image = await pixels(page.png);
    expect([image.width, image.height]).toEqual([page.width, page.height]);
    const px = (x: number) => page.origin.x + x * scale;
    const py = (y: number) => page.origin.y + y * scale;
    const midX = box.x + box.width / 2;
    const midY = box.y + box.height / 2;
    const color = FIELD_COLORS.signature;
    const isOutline = (pixel: Rgb) => [0, 1, 2].every((channel) => Math.abs((pixel[channel] ?? 0) - (color[channel] ?? 0)) <= 12);

    // All four edges of the box, at their midpoints, and a point just outside each.
    const edges = {
      top: { on: [midX, box.y], outside: [midX, box.y - 6] },
      bottom: { on: [midX, box.y + box.height], outside: [midX, box.y + box.height + 6] },
      left: { on: [box.x, midY], outside: [box.x - 6, midY] },
      right: { on: [box.x + box.width, midY], outside: [box.x + box.width + 6, midY] },
    } as const;
    for (const [name, edge] of Object.entries(edges)) {
      const on = image.at(px(edge.on[0]), py(edge.on[1]));
      expect(isOutline(on), `${name} edge is ${on.join(',')}`).toBe(true);
      const outside = image.at(px(edge.outside[0]), py(edge.outside[1]));
      expect(isOutline(outside), `outside the ${name} edge is ${outside.join(',')}`).toBe(false);
    }
    // Inside: the light tint, not the outline.
    expect(isOutline(image.at(px(midX), py(midY)))).toBe(false);
    expect(image.at(px(midX), py(midY))[0]).toBeGreaterThan(230);

    // The page content is turned with the page: the heading, written 72 points from the
    // left of the unrotated page, now runs down the display near its right edge.
    let dark = 0;
    for (let x = 700; x < 740; x += 0.5) {
      for (let y = 72; y < 200; y += 0.5) {
        const [r, g, b] = image.at(px(x), py(y));
        if (r < 90 && g < 90 && b < 90) dark += 1;
      }
    }
    expect(dark).toBeGreaterThan(20);
  });

  it('renders the page content and the grid under the boxes', async () => {
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: BOX }]));
    const [page] = await renderPreview(pdf, resolved, { scale: 2 });
    if (!page) throw new Error('no page rendered');
    const image = await pixels(page.png);
    // The heading starts at x 72 with its baseline 72 points from the top: some pixel there is dark ink.
    let dark = 0;
    for (let x = 72; x < 140; x += 0.5) {
      for (let y = 62; y < 72; y += 0.5) {
        const [r, g, b] = image.at(page.origin.x + x * 2, page.origin.y + y * 2);
        if (r < 90 && g < 90 && b < 90) dark += 1;
      }
    }
    expect(dark).toBeGreaterThan(20);
    // A grid line at x = 300 points: tinted blue, not white.
    const grid = image.at(page.origin.x + 300 * 2, page.origin.y + 475 * 2);
    expect(grid[2]).toBeGreaterThan(grid[0]);
    // The ruler strip is not white.
    expect(image.at(5, page.origin.y + 475 * 2)[0]).toBeLessThan(250);
  });

  it('renders the pages asked for, and refuses pages that do not exist and unusable scales', async () => {
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: BOX }]));
    const pages = await renderPreview(pdf, resolved, { pages: [2], scale: 0.5 });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 2, width: RULER_LEFT + 306, height: RULER_TOP + 396, fieldIds: [] });
    await expect(renderPreview(pdf, resolved, { pages: [4] })).rejects.toMatchObject({ code: 'usage' });
    await expect(renderPreview(pdf, resolved, { scale: 0.1 })).rejects.toMatchObject({ code: 'usage' });
    await expect(renderPreview(pdf, resolved, { scale: 9 })).rejects.toMatchObject({ code: 'usage' });
  });

  it('marks every candidate of an ambiguous anchor with a numbered dashed outline, on pages without fields too', async () => {
    const ini = { id: 'ini', type: 'initials', assignee: 'human', placement: { kind: 'anchor', text: 'Appendix', align: 'below', width: 40, height: 16 } } as const;
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [ini]));
    const [warning] = resolved.warnings;
    expect(warning?.candidates.map((candidate) => candidate.page)).toEqual([2, 3]);
    const anchorCandidates = resolved.warnings.map(({ fieldId, candidates }) => ({ fieldId, candidates }));
    const pages = await renderPreview(pdf, resolved, { scale: 1, anchorCandidates });
    expect(pages.map((page) => [page.page, page.fieldIds, page.candidates])).toEqual([
      [2, ['ini'], [{ fieldId: 'ini', occurrence: 1 }]],
      [3, [], [{ fieldId: 'ini', occurrence: 2 }]],
    ]);
    const second = warning?.candidates[1];
    if (!second || !pages[1]) throw new Error('no second candidate');
    const image = await pixels(pages[1].png);
    // The outline starts with a dash at the top-left corner, 2 points outside the text.
    expectColor(image.at(RULER_LEFT + second.x, RULER_TOP + second.y - 2), FIELD_COLORS.initials, 40);
    // The page has no field box: just right of the outline is blank paper.
    expectColor(image.at(RULER_LEFT + second.x + second.width + 8, RULER_TOP + second.y + second.height / 2), WHITE, 40);
  });
});

describe('renderPreview with placement candidates', () => {
  it('marks each candidate with a dotted outline in its own colour, numbered in order, with or without fields', async () => {
    const inspection = await inspectPdf(pdf);
    const { candidates } = findPlacementCandidates(inspection);
    expect(candidates.map((candidate) => candidate.text)).toEqual(['full_name', 'Signature:', 'Date:']);
    for (const color of Object.values(FIELD_COLORS)) expect(color).not.toEqual(PLACEMENT_CANDIDATE_COLOR);

    const pages = await renderPreview(pdf, { pages: inspection.pages, fields: [] }, { scale: 1, placementCandidates: candidates });
    expect(pages.map((page) => [page.page, page.fieldIds, page.placementCandidates])).toEqual([[1, [], [1, 2, 3]]]);
    const date = candidates[2];
    if (!date || !pages[0]) throw new Error('no Date: candidate');
    const image = await pixels(pages[0].png);
    // The dotted outline starts with a dot at the top-left corner, 3 points outside the label.
    expectColor(image.at(RULER_LEFT + date.x - 3, RULER_TOP + date.y - 3), PLACEMENT_CANDIDATE_COLOR, 40);

    // With a request, the field boxes are drawn too and every candidate is still reported.
    const resolved = await resolveRequest(pdf, await requestFor(pdf));
    const both = await renderPreview(pdf, resolved, { scale: 1, placementCandidates: candidates });
    expect(both.map((page) => [page.fieldIds, page.placementCandidates])).toEqual([[['sig', 'name'], [1, 2, 3]]]);
  });
});

describe('parsePageList', () => {
  it('reads numbers and ranges', () => {
    expect(parsePageList('1,3-5, 3')).toEqual([1, 3, 4, 5]);
    for (const bad of ['', '0', 'a', '3-1', '1,,2', '-2']) {
      expect(() => parsePageList(bad), bad).toThrow();
    }
  });
});

describe('sign-pdf preview', () => {
  it('writes one PNG per page and reports where each field is', async () => {
    const pdfPath = await ws.write('fixture.pdf', pdf);
    const requestPath = await ws.write('request.json', JSON.stringify(await requestFor(pdf)));
    const outDir = ws.path('preview');
    const result = await runCli(['preview', pdfPath, requestPath, '--out', outDir, '--scale', '1', '--json']);
    expect(result.code).toBe(0);
    const out = result.json<{
      images: Array<{ file: string; page: number; width: number; height: number; scale: number; fieldIds: string[] }>;
      fields: Array<{ id: string; rect: { page: number } }>;
    }>();
    expect(await readdir(outDir)).toEqual(['page-1.png']);
    expect(out.images).toMatchObject([{ file: ws.path('preview/page-1.png'), page: 1, width: RULER_LEFT + 612, height: RULER_TOP + 792, scale: 1, fieldIds: ['sig', 'name'] }]);
    expect(out.fields.map((field) => field.id)).toEqual(['sig', 'name']);
    const image = await pixels(new Uint8Array(await readFile(ws.path('preview/page-1.png'))));
    expect([image.width, image.height]).toEqual([RULER_LEFT + 612, RULER_TOP + 792]);

    const some = await runCli(['preview', pdfPath, requestPath, '--out', outDir, '--pages', '2-3']);
    expect(some.code).toBe(0);
    expect((await readdir(outDir)).sort()).toEqual(['page-1.png', 'page-2.png', 'page-3.png']);
    expect(some.stdout).toContain('page-2.png');
  });

  it('marks the candidates with --candidates, with or without a request', async () => {
    const pdfPath = await ws.write('fixture.pdf', pdf);
    const requestPath = await ws.write('request.json', JSON.stringify(await requestFor(pdf)));
    const alone = await runCli(['preview', pdfPath, '--candidates', '--out', ws.path('alone'), '--json']);
    expect(alone.code).toBe(0);
    const out = alone.json<{ images: Array<{ page: number; fieldIds: string[]; placementCandidates: number[] }>; fields: unknown[]; candidates: Array<{ number: number; text: string }> }>();
    expect(out.images.map((image) => [image.page, image.fieldIds, image.placementCandidates])).toEqual([[1, [], [1, 2, 3]]]);
    expect(out.fields).toEqual([]);
    expect(out.candidates.map((candidate) => [candidate.number, candidate.text])).toEqual([[1, 'full_name'], [2, 'Signature:'], [3, 'Date:']]);
    expect(await readdir(ws.path('alone'))).toEqual(['page-1.png']);

    // `--json` right after the flag is still an option, not a value of --candidates.
    const adjacent = await runCli(['preview', pdfPath, '--candidates', '--json', '--out', ws.path('adjacent')]);
    expect(adjacent.code).toBe(0);
    expect(adjacent.json<{ images: unknown[] }>().images.length).toBeGreaterThan(0);

    const withRequest = await runCli(['preview', pdfPath, requestPath, '--candidates', '--out', ws.path('both')]);
    expect(withRequest.code).toBe(0);
    expect(withRequest.stdout).toContain('fields: sig, name  candidates: C1, C2, C3');
    expect(withRequest.stdout).toContain('C3  label  page 1');

    const noRequest = await runCli(['preview', pdfPath, '--out', ws.path('none')]);
    expect(noRequest.code).toBe(1);
    expect(noRequest.stderr).toContain('--candidates');
  });

  it('fails with a clear error for a missing --out, a bad option or an invalid request', async () => {
    const pdfPath = await ws.write('fixture.pdf', pdf);
    const requestPath = await ws.write('request.json', JSON.stringify(await requestFor(pdf)));
    const noOut = await runCli(['preview', pdfPath, requestPath]);
    expect(noOut.code).toBe(1);
    expect(noOut.stderr).toContain('--out');

    for (const extra of [['--scale', 'big'], ['--scale', '40'], ['--pages', '9'], ['--pages', 'x']]) {
      const result = await runCli(['preview', pdfPath, requestPath, '--out', ws.path('p'), ...extra]);
      expect(result.code, extra.join(' ')).toBe(1);
      expect(result.stderr).toContain('error [usage]');
    }

    const bad = await ws.write(
      'bad.json',
      JSON.stringify(await requestFor(pdf, [{ id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'anchor', text: 'Initial here', width: 60, height: 20 } }])),
    );
    const invalid = await runCli(['preview', pdfPath, bad, '--out', ws.path('p')]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('error [anchor-not-found] field "sig"');
  });
});
