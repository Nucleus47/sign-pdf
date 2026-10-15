/**
 * The drawing half of the preview, with a fake canvas and a fake pdf.js. The
 * pixels themselves are checked by the CLI's tests, which use a real canvas.
 */
import type { FieldInput } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import {
  RULER_LEFT,
  RULER_TOP,
  SignPdfError,
  checkPreviewOptions,
  findCandidatesInPdf,
  renderPreview,
  resolveRequest,
  type CanvasLike,
  type Context2d,
  type PreviewRenderer,
} from './index.ts';
import { fixturePdf, requestFor } from './test-helpers.ts';

const rect = (page: number, x: number, y: number, width: number, height: number) =>
  ({ kind: 'rect', page, x, y, width, height }) as const;

interface FakeRenderer extends PreviewRenderer {
  canvases: Array<{ width: number; height: number }>;
  fonts: string[];
  texts: string[];
  documents: Array<Record<string, unknown>>;
  rendered: number[];
  destroyed: number;
}

function fakeRenderer(overrides: Partial<PreviewRenderer> = {}): FakeRenderer {
  const fake: FakeRenderer = {
    canvases: [],
    fonts: [],
    texts: [],
    documents: [],
    rendered: [],
    destroyed: 0,
    createCanvas(width, height): CanvasLike {
      fake.canvases.push({ width, height });
      const noop = () => undefined;
      const ctx: Context2d = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        textBaseline: '',
        textAlign: '',
        set font(value: string) {
          fake.fonts.push(value);
        },
        get font() {
          return fake.fonts.at(-1) ?? '';
        },
        fillRect: noop,
        strokeRect: noop,
        fillText: (text) => void fake.texts.push(text),
        measureText: (text) => ({ width: text.length * 6 }),
        beginPath: noop,
        moveTo: noop,
        lineTo: noop,
        rect: noop,
        stroke: noop,
        clip: noop,
        save: noop,
        restore: noop,
        setLineDash: noop,
        drawImage: noop,
      };
      return { width, height, getContext: () => ctx };
    },
    encodePng: async (canvas) => new Uint8Array([canvas.width % 256, canvas.height % 256]),
    pdfjs: {
      getDocument(source) {
        fake.documents.push(source);
        return {
          promise: Promise.resolve({
            numPages: 3,
            getPage: async (page: number) => ({
              getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
              render: () => {
                fake.rendered.push(page);
                return { promise: Promise.resolve() };
              },
            }),
          }),
          destroy: async () => {
            fake.destroyed++;
          },
        };
      },
    },
    ...overrides,
  };
  return fake;
}

async function layout(fields: FieldInput[], pages = 3) {
  const pdf = await fixturePdf({ pages });
  return { pdf, resolved: await resolveRequest(pdf, await requestFor(pdf, fields)) };
}

const FIELDS: FieldInput[] = [
  { id: 'sig', type: 'signature', assignee: 'human', placement: rect(1, 110, 220, 120, 40) },
  { id: 'init', type: 'initials', assignee: 'human', placement: rect(3, 60, 60, 40, 20) },
  { id: 'name', type: 'text', assignee: 'agent', value: 'Ada Example', placement: rect(3, 60, 120, 200, 20) },
];

describe('renderPreview with an injected renderer', () => {
  it('renders each page that has fields, at the page size times the scale plus the rulers', async () => {
    const { pdf, resolved } = await layout(FIELDS);
    const renderer = fakeRenderer();
    const pages = await renderPreview(pdf, resolved, renderer, { scale: 2 });
    expect(pages.map((page) => page.page)).toEqual([1, 3]);
    expect(renderer.rendered).toEqual([1, 3]);
    for (const page of pages) {
      expect(page).toMatchObject({
        width: RULER_LEFT + 1224,
        height: RULER_TOP + 1584,
        scale: 2,
        origin: { x: RULER_LEFT, y: RULER_TOP },
        pageWidth: 612,
        pageHeight: 792,
      });
      expect(page.png).toEqual(new Uint8Array([(RULER_LEFT + 1224) % 256, (RULER_TOP + 1584) % 256]));
    }
    expect(pages.map((page) => page.fieldIds)).toEqual([['sig'], ['init', 'name']]);
    expect(renderer.destroyed).toBe(1);
    // A page canvas and an output canvas per page.
    expect(renderer.canvases).toHaveLength(4);
    expect(renderer.texts).toContain('sig (signature, human)');
    expect(renderer.texts).toContain('Ada Example');
  });

  it('hands pdf.js a copy of the PDF and the extra options, with eval kept off', async () => {
    const { pdf, resolved } = await layout(FIELDS);
    const renderer = fakeRenderer({ documentOptions: { cMapUrl: 'maps/', isEvalSupported: true, data: 'not this' } });
    await renderPreview(pdf, resolved, renderer, { pages: [1] });
    const source = renderer.documents[0];
    expect(source?.['cMapUrl']).toBe('maps/');
    expect(source?.['isEvalSupported']).toBe(false);
    expect(source?.['data']).toEqual(pdf);
    expect(source?.['data']).not.toBe(pdf);
  });

  it('uses the label font when one is given, with sans-serif after it', async () => {
    const { pdf, resolved } = await layout(FIELDS);
    const plain = fakeRenderer();
    await renderPreview(pdf, resolved, plain, { pages: [1] });
    expect(plain.fonts.length).toBeGreaterThan(0);
    expect(plain.fonts.every((font) => font.endsWith('px sans-serif'))).toBe(true);
    const named = fakeRenderer({ labelFont: 'Example Sans' });
    await renderPreview(pdf, resolved, named, { pages: [1] });
    expect(named.fonts.every((font) => font.endsWith('px Example Sans, sans-serif'))).toBe(true);
  });

  it('marks anchor candidates and placement candidates, on pages without fields too', async () => {
    const pdf = await fixturePdf({ pages: 3 });
    const resolved = await resolveRequest(pdf, await requestFor(pdf, [FIELDS[0] as FieldInput]));
    const { candidates } = await findCandidatesInPdf(pdf);
    const renderer = fakeRenderer();
    const pages = await renderPreview(pdf, resolved, renderer, {
      anchorCandidates: [
        { fieldId: 'sig', candidates: [{ page: 2, x: 72, y: 60, width: 60, height: 14 }, { page: 3, x: 72, y: 60, width: 60, height: 14 }] },
        { fieldId: 'missing', candidates: [{ page: 2, x: 10, y: 10, width: 10, height: 10 }] },
      ],
      placementCandidates: candidates,
    });
    expect(pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(pages[0]?.placementCandidates).toEqual(candidates.map((_, index) => index + 1));
    expect(pages[1]).toMatchObject({ fieldIds: [], candidates: [{ fieldId: 'sig', occurrence: 1 }], placementCandidates: [] });
    expect(pages[2]?.candidates).toEqual([{ fieldId: 'sig', occurrence: 2 }]);
    expect(renderer.texts).toContain('sig #2');
    expect(renderer.texts).toContain('C1');
  });

  it('refuses a bad scale, a missing page and a page too large, with invalid-argument', async () => {
    const { pdf, resolved } = await layout(FIELDS);
    for (const options of [{ scale: 0.1 }, { scale: 5 }, { scale: Number.NaN }, { pages: [4] }, { pages: [0] }, { pages: [1.5] }]) {
      expect(() => checkPreviewOptions(resolved, options), JSON.stringify(options)).toThrow(SignPdfError);
      const renderer = fakeRenderer();
      await expect(renderPreview(pdf, resolved, renderer, options)).rejects.toMatchObject({ code: 'invalid-argument' });
      // Checked before pdf.js opens the document.
      expect(renderer.documents).toEqual([]);
    }
    expect(() => checkPreviewOptions(resolved, { scale: 4, pages: [2] })).not.toThrow();

    const huge = { pages: [{ page: 1, width: 14_400, height: 14_400 }], fields: [] };
    const renderer = fakeRenderer();
    await expect(renderPreview(pdf, huge, renderer, { pages: [1], scale: 1 })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(renderer.destroyed).toBe(1);
  });
});
