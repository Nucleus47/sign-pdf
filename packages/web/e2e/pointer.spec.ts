import { expect, test } from '@playwright/test';
import { addFieldByForm, auditField, auditOf, downloadRequestJson, dragByPoints, expectOnlyOwnStaticAssets, fieldRect, openSample, pageScale, showAllFields, signAndDownload, SIGNER, textPosition, watch } from './helpers.ts';

// A pointer lands on whole CSS pixels, so a position asked for in points is met to within a pixel.
const within = (scale: number) => 1 / scale + 0.01;

test('click the page to place a field where the pointer is', async ({ page, baseURL }) => {
  const seen = watch(page);
  await openSample(page);
  const scale = await pageScale(page, 1);
  const sheet = await page.getByTestId('pdf-page-1').boundingBox();
  if (!sheet) throw new Error('page 1 has no box');
  // A real pointer click at a position on page 1, given in points.
  const clickAt = (xPt: number, yPt: number) => page.mouse.click(sheet.x + xPt * scale, sheet.y + yPt * scale);

  // Without a type chosen, a click on the page places nothing.
  await clickAt(100, 80);
  await expect(page.getByTestId('field-count')).toHaveText('0');

  await page.getByTestId('place-text').click();
  await expect(page.getByTestId('place-text')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('prepare-status')).toContainText('Click the page to place a text field');
  await clickAt(100, 150);
  await expect(page.getByTestId('field-count')).toHaveText('1');
  // Placing is one-shot: the tool switches itself off.
  await expect(page.getByTestId('place-text')).toHaveAttribute('aria-pressed', 'false');

  const text = await fieldRect(page, 'text1');
  expect(text.page).toBe(1);
  expect(Math.abs(text.x - 100)).toBeLessThanOrEqual(within(scale));
  expect(Math.abs(text.y - 150)).toBeLessThanOrEqual(within(scale));
  expect(text.width).toBe(180);
  expect(text.height).toBe(18);

  await page.getByTestId('place-signature').click();
  await clickAt(320, 220);
  await expect(page.getByTestId('field-count')).toHaveText('2');
  const signature = await fieldRect(page, 'signature1');
  expect(Math.abs(signature.x - 320)).toBeLessThanOrEqual(within(scale));
  expect(Math.abs(signature.y - 220)).toBeLessThanOrEqual(within(scale));
  expect(signature.width).toBe(180);
  expect(signature.height).toBe(44);

  // A click near the page edge keeps the whole field on the page.
  await page.getByTestId('place-date').click();
  await clickAt(606, 40);
  const date = await fieldRect(page, 'date1');
  expect(date.x + date.width).toBeLessThanOrEqual(612);
  expect(date.x).toBe(612 - 90);

  // Pressing the tool again cancels placing.
  await page.getByTestId('place-checkbox').click();
  await page.getByTestId('place-checkbox').click();
  await clickAt(60, 60);
  await expect(page.getByTestId('field-count')).toHaveText('3');

  // The exported request holds exactly the rectangles shown.
  const request = await downloadRequestJson(page);
  expect(request.fields.map((field) => field.id)).toEqual(['text1', 'signature1', 'date1']);
  expect(request.fields[0]?.placement).toEqual({ kind: 'rect', ...text });
  expect(request.fields[1]?.placement).toEqual({ kind: 'rect', ...signature });
  expect(request.fields[2]?.placement).toEqual({ kind: 'rect', ...date });

  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});

test('drag moves a field, handles resize it, and the request and the signed PDF follow', async ({ page, baseURL }) => {
  const seen = watch(page);
  await openSample(page);
  await addFieldByForm(page, { type: 'text', label: 'Dragged field', page: 1, x: 100, y: 100, width: 180, height: 18 });
  const scale = await pageScale(page, 1);
  const tolerance = within(scale);
  const box = page.getByTestId('field-box-text1');

  // Move.
  await dragByPoints(page, box, 60, 40, scale);
  let rect = await fieldRect(page, 'text1');
  expect(Math.abs(rect.x - 160)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(rect.y - 140)).toBeLessThanOrEqual(tolerance);
  expect(rect.width).toBe(180);
  expect(rect.height).toBe(18);
  const moved = rect;

  // The dragged field is selected and shows its four handles.
  await expect(box).toHaveAttribute('data-selected', 'true');
  for (const handle of ['nw', 'ne', 'sw', 'se']) {
    await expect(page.getByTestId(`field-handle-text1-${handle}`)).toBeVisible();
  }

  // Bottom-right handle: the top-left corner stays, the size grows.
  await dragByPoints(page, page.getByTestId('field-handle-text1-se'), 30, 12, scale);
  rect = await fieldRect(page, 'text1');
  expect(rect.x).toBe(moved.x);
  expect(rect.y).toBe(moved.y);
  expect(Math.abs(rect.width - 210)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(rect.height - 30)).toBeLessThanOrEqual(tolerance);
  const grown = rect;

  // Top-left handle: the bottom-right corner stays.
  await dragByPoints(page, page.getByTestId('field-handle-text1-nw'), -20, -10, scale);
  rect = await fieldRect(page, 'text1');
  expect(Math.abs(rect.x - (grown.x - 20))).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(rect.y - (grown.y - 10))).toBeLessThanOrEqual(tolerance);
  expect(rect.x + rect.width).toBeCloseTo(grown.x + grown.width, 1);
  expect(rect.y + rect.height).toBeCloseTo(grown.y + grown.height, 1);

  // Top-right handle: the bottom-left corner stays.
  const beforeNe = rect;
  await dragByPoints(page, page.getByTestId('field-handle-text1-ne'), -40, 6, scale);
  rect = await fieldRect(page, 'text1');
  expect(rect.x).toBe(beforeNe.x);
  expect(Math.abs(rect.width - (beforeNe.width - 40))).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(rect.y - (beforeNe.y + 6))).toBeLessThanOrEqual(tolerance);
  expect(rect.y + rect.height).toBeCloseTo(beforeNe.y + beforeNe.height, 1);

  // A drag past the page edge stops at the edge.
  await dragByPoints(page, box, -700, 0, scale);
  rect = await fieldRect(page, 'text1');
  expect(rect.x).toBe(0);
  await dragByPoints(page, box, 120, 0, scale);
  const prepared = await fieldRect(page, 'text1');
  expect(Math.abs(prepared.x - 120)).toBeLessThanOrEqual(tolerance);
  expect(prepared.width).toBeGreaterThan(150);
  expect(prepared.height).toBeGreaterThanOrEqual(18);

  // A second field: a handle cannot shrink it below the minimum size, and its corner stays put.
  await addFieldByForm(page, { type: 'checkbox', label: 'Shrunk box', page: 1, x: 400, y: 60, width: 40, height: 40 });
  await page.getByTestId('field-box-checkbox1').click();
  await dragByPoints(page, page.getByTestId('field-handle-checkbox1-se'), -300, -300, scale);
  expect(await fieldRect(page, 'checkbox1')).toEqual({ page: 1, x: 400, y: 60, width: 6, height: 6 });
  await page.getByTestId('field-remove-checkbox1').click();
  await expect(page.getByTestId('field-count')).toHaveText('1');

  // The field row shows the same numbers, and so does the exported request.
  const request = await downloadRequestJson(page);
  expect(request.fields[0]?.placement).toEqual({ kind: 'rect', ...prepared });

  // Sign view: the box is where it was left, and can be dragged there too.
  await page.getByTestId('continue-to-sign').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await showAllFields(page);
  expect(await fieldRect(page, 'text1')).toEqual(prepared);
  const signScale = await pageScale(page, 1);
  await dragByPoints(page, page.getByTestId('field-box-text1'), 24, 30, signScale);
  const final = await fieldRect(page, 'text1');
  expect(Math.abs(final.x - (prepared.x + 24))).toBeLessThanOrEqual(within(signScale));
  expect(Math.abs(final.y - (prepared.y + 30))).toBeLessThanOrEqual(within(signScale));
  expect(final.width).toBe(prepared.width);

  await page.getByTestId('value-text1').fill('Moved Value');
  const signed = await signAndDownload(page);

  // The signed PDF's own record carries the final rectangle...
  const audit = await auditOf(signed);
  expect(audit.signer.name).toBe(SIGNER);
  const entry = auditField(audit, 'text1');
  expect(entry.rect).toEqual(final);
  expect(entry.movedByHuman).toBe(true);
  expect(entry.value).toBe('Moved Value');
  await expect(page.getByTestId('audit-moved')).toContainText('Dragged field');

  // ...and the value is printed inside it, as read back from the signed page.
  const drawn = await textPosition(page, 1, 'Moved Value');
  expect(drawn.x).toBeGreaterThanOrEqual(final.x - 1);
  expect(drawn.right).toBeLessThanOrEqual(final.x + final.width + 1);
  expect(drawn.y).toBeGreaterThanOrEqual(final.y - 2);
  expect(drawn.bottom).toBeLessThanOrEqual(final.y + final.height + 2);

  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});
