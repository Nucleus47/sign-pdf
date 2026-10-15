import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { auditField, auditOf, downloadRequestJson, dragByPoints, expectOnlyOwnStaticAssets, fieldRect, openSample, PAGE_WIDTH_PT, pageScale, showAllFields, signAndDownload, textPosition, type TextBox, watch } from './helpers.ts';

/**
 * Where the first occurrence of some words is printed on a shown page, in points, measured
 * on the pdf.js text layer with a DOM Range. This is independent of the core's anchor search.
 */
async function printedAt(page: Page, pageNumber: number, words: string): Promise<TextBox> {
  const layer = page.getByTestId(`pdf-page-${pageNumber}`).locator('.textLayer');
  await expect(layer).toContainText(words);
  return layer.evaluate(
    (element, { wanted, widthPt }) => {
      // Case-sensitive, first run in document order.
      const node = Array.from(element.querySelectorAll('span'))
        .map((span) => span.firstChild)
        .find((child) => child?.nodeType === Node.TEXT_NODE && child.textContent?.includes(wanted));
      const start = node?.textContent?.indexOf(wanted) ?? -1;
      if (!node || start < 0) throw new Error('words are not in one text run');
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + wanted.length);
      const box = range.getBoundingClientRect();
      const pageBox = (element.closest('[data-page]') as HTMLElement).getBoundingClientRect();
      const scale = pageBox.width / widthPt;
      return {
        x: (box.left - pageBox.left) / scale,
        y: (box.top - pageBox.top) / scale,
        right: (box.right - pageBox.left) / scale,
        bottom: (box.bottom - pageBox.top) / scale,
      };
    },
    { wanted: words, widthPt: PAGE_WIDTH_PT },
  );
}

async function addByAnchor(
  page: Page,
  options: { type: string; label: string; text: string; align: string; onPage?: number; width: number; height: number },
): Promise<void> {
  await page.getByTestId('add-type').selectOption(options.type);
  await page.getByTestId('add-label').fill(options.label);
  await page.getByTestId('add-mode-anchor').check();
  await page.getByTestId('add-anchor-text').fill(options.text);
  await page.getByTestId('add-anchor-align').selectOption(options.align);
  await page.getByTestId('add-anchor-any-page').setChecked(options.onPage === undefined);
  if (options.onPage !== undefined) await page.getByTestId('add-page').fill(String(options.onPage));
  await page.getByTestId('add-width').fill(String(options.width));
  await page.getByTestId('add-height').fill(String(options.height));
  await page.getByTestId('add-field').click();
}

test('add a field next to text printed on the sample', async ({ page, baseURL }) => {
  const seen = watch(page);
  await openSample(page);

  // To the right of the first "Print Name", searching every page: it is on page 3.
  await addByAnchor(page, { type: 'text', label: 'Party A name', text: 'Print Name', align: 'right', width: 170, height: 16 });
  await expect(page.getByTestId('field-count')).toHaveText('1');
  const name = await fieldRect(page, 'text1');
  const printName = await printedAt(page, 3, 'Print Name');
  expect(name.page).toBe(3);
  expect(name.width).toBe(170);
  expect(name.height).toBe(16);
  // It starts just after the words and sits on their line.
  expect(name.x).toBeGreaterThanOrEqual(printName.right - 2);
  expect(name.x).toBeLessThanOrEqual(printName.right + 12);
  const nameMiddle = name.y + name.height / 2;
  expect(nameMiddle).toBeGreaterThan(printName.y - 2);
  expect(nameMiddle).toBeLessThan(printName.bottom + 2);

  // Below "Party B" on page 3 only (the search ignores case; "party b" is a whole-word match).
  await addByAnchor(page, { type: 'date', label: 'Date signed', text: 'party b', align: 'below', onPage: 3, width: 90, height: 16 });
  await expect(page.getByTestId('field-count')).toHaveText('2');
  const date = await fieldRect(page, 'date1');
  const printedDate = await printedAt(page, 3, 'Party B');
  expect(date.page).toBe(3);
  expect(Math.abs(date.x - printedDate.x)).toBeLessThanOrEqual(2);
  expect(date.y).toBeGreaterThanOrEqual(printedDate.bottom - 3);
  expect(date.y).toBeLessThanOrEqual(printedDate.bottom + 12);

  // Words that are not there: a plain message, and no field.
  await addByAnchor(page, { type: 'text', label: 'Nowhere', text: 'No Such Words Here', align: 'right', width: 100, height: 16 });
  await expect(page.getByTestId('add-error')).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('add-error')).toContainText('“No Such Words Here” was not found in the document.');
  await addByAnchor(page, { type: 'text', label: 'Nowhere', text: 'Print Name', align: 'right', onPage: 1, width: 100, height: 16 });
  await expect(page.getByTestId('add-error')).toContainText('“Print Name” was not found on page 1.');
  await page.getByTestId('add-anchor-text').fill('   ');
  await page.getByTestId('add-field').click();
  await expect(page.getByTestId('add-error')).toContainText('Type the text the field should sit next to.');
  await expect(page.getByTestId('field-count')).toHaveText('2');

  // The request keeps the anchors as typed; the audit below shows they resolve to the same rectangles.
  const request = await downloadRequestJson(page);
  expect(request.fields.map((field) => field.placement)).toEqual([
    { kind: 'anchor', text: 'Print Name', align: 'right', width: 170, height: 16 },
    { kind: 'anchor', text: 'party b', page: 3, align: 'below', width: 90, height: 16 },
  ]);

  await page.getByTestId('continue-to-sign').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await showAllFields(page);
  await page.getByTestId('value-text1').fill('Anchored Name');
  const signed = await signAndDownload(page);
  const audit = await auditOf(signed);
  expect(auditField(audit, 'text1').rect).toEqual(name);
  expect(auditField(audit, 'date1').rect).toEqual(date);
  const drawn = await textPosition(page, 3, 'Anchored Name');
  expect(drawn.x).toBeGreaterThanOrEqual(name.x - 1);
  expect(drawn.y).toBeGreaterThanOrEqual(name.y - 2);
  expect(drawn.bottom).toBeLessThanOrEqual(name.y + name.height + 2);

  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});

/** A one-page synthetic form: two usable fields, one read-only field and one drop-down. */
async function buildFormPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sheet.drawText('Synthetic membership form', { x: 72, y: 720, size: 16, font });
  sheet.drawText('Member name', { x: 72, y: 664, size: 10, font });
  const form = doc.getForm();
  const name = form.createTextField('member.name');
  name.addToPage(sheet, { x: 72, y: 630, width: 220, height: 22, borderWidth: 0, font });
  const agree = form.createCheckBox('member.agrees');
  agree.addToPage(sheet, { x: 72, y: 580, width: 16, height: 16, borderWidth: 0 });
  const fixed = form.createTextField('office.reference');
  fixed.setText('REF-0001');
  fixed.addToPage(sheet, { x: 340, y: 630, width: 120, height: 22, borderWidth: 0, font });
  fixed.enableReadOnly();
  const plan = form.createDropdown('member.plan');
  plan.addOptions(['Basic', 'Plus']);
  plan.addToPage(sheet, { x: 72, y: 530, width: 120, height: 20, borderWidth: 0, font });
  return Buffer.from(await doc.save());
}

test('use the existing form fields of a PDF', async ({ page, baseURL }) => {
  const seen = watch(page);
  const pdf = await buildFormPdf();
  await page.goto('/');
  await page.getByTestId('open-pdf-input').setInputFiles({ name: 'membership-form.pdf', mimeType: 'application/pdf', buffer: pdf });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('pdf-page-1')).toBeVisible();

  // Only the writable text field and the checkbox can be reused.
  const use = page.getByTestId('use-acro-fields');
  await expect(use).toHaveText('Use existing form fields (2)');
  await use.click();
  await expect(page.getByTestId('field-count')).toHaveText('2');
  await expect(use).toBeDisabled();
  await expect(use).toHaveText('Form fields added');

  // Top-left coordinates: 792 - 630 - 22 = 140 and 792 - 580 - 16 = 196.
  const name = await fieldRect(page, 'text1');
  expect(name).toEqual({ page: 1, x: 72, y: 140, width: 220, height: 22 });
  const agree = await fieldRect(page, 'checkbox1');
  expect(agree).toEqual({ page: 1, x: 72, y: 196, width: 16, height: 16 });
  await expect(page.getByTestId('field-label-text1')).toHaveValue('member.name');

  // A linked field follows the form field: a drag does not move it.
  const box = page.getByTestId('field-box-text1');
  await expect(box).toHaveAttribute('data-locked', 'true');
  await dragByPoints(page, box, 50, 50, await pageScale(page, 1));
  expect(await fieldRect(page, 'text1')).toEqual(name);
  await expect(page.getByTestId('field-handle-text1-se')).toHaveCount(0);

  const request = await downloadRequestJson(page);
  expect(request.document.name).toBe('membership-form.pdf');
  expect(request.fields.map((field) => field.placement)).toEqual([
    { kind: 'acroField', name: 'member.name' },
    { kind: 'acroField', name: 'member.agrees' },
  ]);

  await page.getByTestId('continue-to-sign').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await showAllFields(page);
  expect(await fieldRect(page, 'text1')).toEqual(name);
  await page.getByTestId('value-text1').fill('Example Member');
  await page.getByTestId('value-checkbox1').check();
  const signed = await signAndDownload(page);

  const audit = await auditOf(signed);
  expect(auditField(audit, 'text1')).toMatchObject({ rect: name, value: 'Example Member', filledBy: 'human', movedByHuman: false });
  expect(auditField(audit, 'checkbox1')).toMatchObject({ rect: agree, value: true });

  // The value is printed in the form field's place, and the two fields are no longer fillable.
  const drawn = await textPosition(page, 1, 'Example Member');
  expect(drawn.x).toBeGreaterThanOrEqual(name.x - 1);
  expect(drawn.x).toBeLessThan(name.x + 12);
  expect(drawn.y).toBeGreaterThanOrEqual(name.y - 2);
  expect(drawn.bottom).toBeLessThanOrEqual(name.y + name.height + 2);
  const remaining = (await PDFDocument.load(signed)).getForm().getFields().map((field) => field.getName());
  expect(remaining).not.toContain('member.name');
  expect(remaining).not.toContain('member.agrees');

  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});
