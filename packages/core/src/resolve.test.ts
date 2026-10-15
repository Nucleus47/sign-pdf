import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import type { FieldInput, PlacementInput } from '@sign-pdf/spec';
import { beforeAll, describe, expect, it } from 'vitest';
import { SignPdfError, resolveRequest, resolveRequestCollect } from './index.ts';
import { requestFor } from './test-helpers.ts';

const GAP = 4;
let pdf: Uint8Array;
/** Width of text at size 12 in the regular (w) and bold (wb) fixture fonts. */
let w: (text: string) => number;
let wb: (text: string) => number;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  w = (text) => regular.widthOfTextAtSize(text, 12);
  wb = (text) => bold.widthOfTextAtSize(text, 12);

  const page = doc.addPage([612, 792]);
  const draw = (text: string, x: number, y: number, font = regular) =>
    page.drawText(text, { x, y, size: 12, font });
  draw('Signature:', 72, 692);
  draw('Name: Ada Example Title: Engineer', 72, 650);
  // Two runs (different fonts) separated by a visible gap: "Date of" + "birth:".
  draw('Date of', 72, 610);
  draw('birth:', 72 + w('Date of') + GAP, 610, bold);
  // Two runs that touch, as when a producer splits one word: "Sig" + "ned by".
  draw('Sig', 72, 570);
  draw('ned by', 72 + w('Sig'), 570, bold);
  draw('Initial here', 72, 530);
  draw('Initial here', 300, 530);
  const form = doc.getForm();
  form.createTextField('party.email').addToPage(page, { x: 72, y: 400, width: 180, height: 22, borderWidth: 0 });

  const second = doc.addPage([612, 792]);
  second.drawText('Initial here', { x: 90, y: 700, size: 12, font: regular });
  pdf = await doc.save();
});

const signature = (placement: PlacementInput, id = 'sig'): FieldInput => ({
  id,
  type: 'signature',
  assignee: 'human',
  placement,
});

async function rectOf(placement: PlacementInput) {
  const resolved = await resolveRequest(pdf, await requestFor(pdf, [signature(placement)]));
  const field = resolved.fields[0];
  if (!field) throw new Error('no field');
  return field.rect;
}

async function failure(fields: FieldInput[]): Promise<SignPdfError> {
  const error = await resolveRequest(pdf, await requestFor(pdf, fields)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SignPdfError);
  return error as SignPdfError;
}

const anchor = (text: string, extra: Record<string, unknown> = {}): PlacementInput => ({
  kind: 'anchor',
  text,
  width: 120,
  height: 20,
  ...extra,
});

describe('resolveRequest', () => {
  it('returns the pages, the parsed request and a rect placement unchanged', async () => {
    const resolved = await resolveRequest(
      pdf,
      await requestFor(pdf, [signature({ kind: 'rect', page: 2, x: 10, y: 20, width: 100, height: 30 })]),
    );
    expect(resolved.pages).toEqual([
      { page: 1, width: 612, height: 792 },
      { page: 2, width: 612, height: 792 },
    ]);
    expect(resolved.fields[0]).toMatchObject({
      id: 'sig',
      required: true,
      rect: { page: 2, x: 10, y: 20, width: 100, height: 30 },
    });
    expect(resolved.request.fields[0]?.required).toBe(true);
  });

  describe('anchor placement', () => {
    // "Signature:" has its baseline at native y 692, so its box is y 88..100 from the top.
    it('align right (default): starts at the text\'s right edge, centred on it', async () => {
      const rect = await rectOf(anchor('Signature:'));
      expect(rect.page).toBe(1);
      expect(rect.x).toBeCloseTo(72 + w('Signature:'), 1);
      expect(rect.y).toBeCloseTo(88 + 6 - 10, 1);
      expect(rect).toMatchObject({ width: 120, height: 20 });
    });

    it('align below, above and over', async () => {
      const below = await rectOf(anchor('Signature:', { align: 'below' }));
      expect(below.x).toBeCloseTo(72, 1);
      expect(below.y).toBeCloseTo(100, 1);
      const above = await rectOf(anchor('Signature:', { align: 'above' }));
      expect(above.x).toBeCloseTo(72, 1);
      expect(above.y).toBeCloseTo(88 - 20, 1);
      const over = await rectOf(anchor('Signature:', { align: 'over' }));
      expect(over.x).toBeCloseTo(72, 1);
      expect(over.y).toBeCloseTo(88, 1);
    });

    it('applies dx and dy after the alignment', async () => {
      const rect = await rectOf(anchor('Signature:', { align: 'below', dx: 15, dy: -3 }));
      expect(rect.x).toBeCloseTo(87, 1);
      expect(rect.y).toBeCloseTo(97, 1);
    });

    it('ignores case and collapses whitespace', async () => {
      const rect = await rectOf(anchor('  sIGNATURE:\n', { align: 'over' }));
      expect(rect.x).toBeCloseTo(72, 1);
      expect(rect.y).toBeCloseTo(88, 1);
    });

    it('finds a substring of a run and estimates its horizontal extent', async () => {
      const rect = await rectOf(anchor('Title:', { align: 'over' }));
      // The estimate is proportional to character count, so it is near the true start
      // (known from the font) but not on it: within one character or so.
      expect(Math.abs(rect.x - (72 + w('Name: Ada Example ')))).toBeLessThan(12);
      expect(rect.y).toBeCloseTo(792 - 650 - 12, 1);
      const right = await rectOf(anchor('Title:'));
      expect(Math.abs(right.x - (72 + w('Name: Ada Example Title:')))).toBeLessThan(12);
    });

    it('matches text that spans runs separated by a gap', async () => {
      const over = await rectOf(anchor('date   of BIRTH:', { align: 'over' }));
      expect(over.x).toBeCloseTo(72, 1);
      expect(over.y).toBeCloseTo(792 - 610 - 12, 1);
      const right = await rectOf(anchor('Date of birth:'));
      // pdf-lib kerns when it measures, pdf.js does not: allow half a point.
      expect(right.x).toBeCloseTo(72 + w('Date of') + GAP + wb('birth:'), 0);
    });

    it('matches a word split across touching runs', async () => {
      const right = await rectOf(anchor('Signed by'));
      expect(right.x).toBeCloseTo(72 + w('Sig') + wb('ned by'), 0);
      // The split word has no space in it.
      expect((await failure([signature(anchor('Sig ned'))])).code).toBe('anchor-not-found');
    });

    it('selects by occurrence in reading order, across pages', async () => {
      const first = await rectOf(anchor('Initial here', { align: 'over' }));
      expect(first).toMatchObject({ page: 1 });
      expect(first.x).toBeCloseTo(72, 1);
      const second = await rectOf(anchor('Initial here', { align: 'over', occurrence: 2 }));
      expect(second).toMatchObject({ page: 1 });
      expect(second.x).toBeCloseTo(300, 1);
      const third = await rectOf(anchor('Initial here', { align: 'over', occurrence: 3 }));
      expect(third).toMatchObject({ page: 2 });
      expect(third.x).toBeCloseTo(90, 1);
    });

    it('limits the search to one page when asked', async () => {
      const rect = await rectOf(anchor('Initial here', { align: 'over', page: 2 }));
      expect(rect).toMatchObject({ page: 2 });
      expect(rect.x).toBeCloseTo(90, 1);
    });

    it('fails with anchor-not-found and the field id', async () => {
      const missing = await failure([signature(anchor('No such label'), 'witness')]);
      expect(missing.code).toBe('anchor-not-found');
      expect(missing.fieldId).toBe('witness');
      const tooFar = await failure([signature(anchor('Initial here', { occurrence: 4 }))]);
      expect(tooFar.code).toBe('anchor-not-found');
      const wrongPage = await failure([signature(anchor('Signature:', { page: 2 }))]);
      expect(wrongPage.code).toBe('anchor-not-found');
    });
  });

  it('resolves an acroField placement to the widget rect', async () => {
    const rect = await rectOf({ kind: 'acroField', name: 'party.email' });
    expect(rect).toEqual({ page: 1, x: 72, y: 792 - 400 - 22, width: 180, height: 22 });
  });

  it('fails with acro-field-not-found', async () => {
    const error = await failure([signature({ kind: 'acroField', name: 'party.phone' }, 'phone')]);
    expect(error.code).toBe('acro-field-not-found');
    expect(error.fieldId).toBe('phone');
  });

  it('fails with page-out-of-range', async () => {
    const byRect = await failure([signature({ kind: 'rect', page: 3, x: 0, y: 0, width: 10, height: 10 }, 'r')]);
    expect(byRect.code).toBe('page-out-of-range');
    expect(byRect.fieldId).toBe('r');
    const byAnchor = await failure([signature(anchor('Signature:', { page: 9 }), 'a')]);
    expect(byAnchor.code).toBe('page-out-of-range');
    expect(byAnchor.fieldId).toBe('a');
  });

  it('fails with field-out-of-bounds when a field leaves its page', async () => {
    const byRect = await failure([signature({ kind: 'rect', page: 1, x: 600, y: 10, width: 50, height: 10 }, 'edge')]);
    expect(byRect.code).toBe('field-out-of-bounds');
    expect(byRect.fieldId).toBe('edge');
    const byAnchor = await failure([signature(anchor('Signature:', { dx: 500 }), 'pushed')]);
    expect(byAnchor.code).toBe('field-out-of-bounds');
    expect(byAnchor.fieldId).toBe('pushed');
  });

  it('fails with hash-mismatch when the request was written for other bytes', async () => {
    const request = await requestFor(pdf, [signature(anchor('Signature:'))]);
    request.document.sha256 = 'a'.repeat(64);
    const error = await resolveRequest(pdf, request).catch((e: unknown) => e);
    expect((error as SignPdfError).code).toBe('hash-mismatch');
  });

  it('fails with invalid-request and lists every issue', async () => {
    const rect: PlacementInput = { kind: 'rect', page: 1, x: 0, y: 0, width: 10, height: 10 };
    const error = await failure([
      signature(rect, 'dup'),
      signature(rect, 'dup'),
      { id: 'note', type: 'text', assignee: 'agent', placement: rect },
    ]);
    expect(error.code).toBe('invalid-request');
    expect(error.message).toContain('fields.1.id: duplicate field id "dup"');
    expect(error.message).toContain('fields.2.value: a field assigned to the agent must include a value');
  });
});

describe('resolveRequestCollect', () => {
  const ok = signature(anchor('Signature:'), 'ok');
  const bad: FieldInput[] = [
    signature({ kind: 'acroField', name: 'party.phone' }, 'phone'),
    ok,
    signature({ kind: 'rect', page: 3, x: 0, y: 0, width: 10, height: 10 }, 'far'),
    signature(anchor('Not in the document'), 'lost'),
    { id: 'long', type: 'text', assignee: 'agent', value: 'x'.repeat(400), placement: { kind: 'rect', page: 1, x: 72, y: 72, width: 40, height: 12 } },
  ];

  it('reports every bad field in request order and keeps the fields that resolved', async () => {
    const report = await resolveRequestCollect(pdf, await requestFor(pdf, bad));
    expect(report.errors.map((error) => [error.fieldId, error.code])).toEqual([
      ['phone', 'acro-field-not-found'],
      ['far', 'page-out-of-range'],
      ['lost', 'anchor-not-found'],
      ['long', 'value-does-not-fit'],
    ]);
    expect(report.errors.every((error) => error instanceof SignPdfError)).toBe(true);
    expect(report.fields.map((field) => field.id)).toEqual(['ok']);
    expect(report.resolved).toBeUndefined();
  });

  it('matches resolveRequest: the same first error, and the same result when every field resolves', async () => {
    const request = await requestFor(pdf, bad);
    const thrown = await resolveRequest(pdf, request).catch((e: unknown) => e);
    const [first] = (await resolveRequestCollect(pdf, request)).errors;
    expect(thrown).toBeInstanceOf(SignPdfError);
    expect(thrown).toMatchObject({ code: first?.code, fieldId: 'phone', message: first?.message });

    const good = await requestFor(pdf, [ok]);
    const report = await resolveRequestCollect(pdf, good);
    expect(report.errors).toEqual([]);
    expect(report.resolved).toEqual(await resolveRequest(pdf, good));
    expect(report.fields).toEqual(report.resolved?.fields);
  });

  it('still throws for a problem with the whole request', async () => {
    const request = await requestFor(pdf, [ok]);
    request.document.sha256 = 'a'.repeat(64);
    const error = await resolveRequestCollect(pdf, request).catch((e: unknown) => e);
    expect((error as SignPdfError).code).toBe('hash-mismatch');
  });
});
