import { expect, test, type Locator, type Page } from '@playwright/test';
import { downloadRequestJson, openSample } from './helpers.ts';

/** Show page 3 at the top of the viewer and give the page region focus. */
async function focusPage3(page: Page): Promise<Locator> {
  await openSample(page);
  await page.getByTestId('pdf-page-3').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const region = page.getByRole('group', { name: 'Pages' });
  await region.focus();
  await expect(page.getByTestId('place-count')).not.toHaveText('0');
  return region;
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('M shows numbered places, a number starts a field there and the export keeps its anchor or form field', async ({ page }) => {
  await focusPage3(page);
  const ghost = page.getByTestId('field-ghost');

  await page.keyboard.press('m');
  const list = page.getByTestId('place-list');
  await expect(list).toBeVisible();
  // The list is plain text an agent or screen reader can read, one button per place.
  await expect(page.getByRole('button', { name: /^1: line after “Party A’s Signature”, page 3/ })).toBeVisible();
  const marker = page.getByTestId('place-mark-3-1');
  await expect(marker).toBeVisible();

  // The badge sits beside the place, not over the printed label.
  const badge = await marker.locator('.place-mark-badge').boundingBox();
  const label = await page.getByTestId('pdf-page-3').locator('.textLayer span', { hasText: 'Party A’s Signature' }).first().boundingBox();
  expect(badge && label && overlaps(badge, label)).toBe(false);

  // 1 starts a signature field on the place; Enter adds it.
  await page.keyboard.press('1');
  await expect(ghost).toHaveAttribute('data-type', 'signature');
  await expect(marker).toHaveAttribute('data-active', 'true');
  // The ghost's tag shows the number; the place's own badge hides, so the tag never covers it.
  await expect(page.getByTestId('field-ghost-place')).toHaveText('1');
  await expect(marker.locator('.place-mark-badge')).toBeHidden();
  await expect(page.getByTestId('prepare-status')).toContainText('at place 1: line after “Party A’s Signature”, page 3');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('field-count')).toHaveText('1');
  await expect(page.getByTestId('field-anchor-signature1')).toContainText('Party A’s Signature');

  // From a focused field, 2 starts a field on the existing "Date" form field.
  await expect(page.getByTestId('field-box-signature1')).toBeFocused();
  await page.keyboard.press('2');
  await expect(ghost).toHaveAttribute('data-type', 'date');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('field-count')).toHaveText('2');

  // M hides the markers again.
  await page.keyboard.press('m');
  await expect(marker).toHaveCount(0);

  const request = await downloadRequestJson(page);
  expect(request.fields[0]?.placement).toMatchObject({ kind: 'anchor', text: 'Party A’s Signature', page: 3, align: 'right' });
  expect(request.fields[1]?.placement).toEqual({ kind: 'acroField', name: 'Date' });
});

test('a field placed from the list and then moved exports a rectangle', async ({ page }) => {
  await focusPage3(page);
  await page.getByTestId('toggle-places').click();
  await page.getByRole('button', { name: /^4: line after “Party B’s Signature”, page 3/ }).click();

  // The page region has focus, so Enter adds the field.
  const ghost = page.getByTestId('field-ghost');
  await expect(ghost).toHaveAttribute('data-type', 'signature');
  await page.keyboard.press('Enter');
  const box = page.getByTestId('field-box-signature1');
  await expect(box).toBeFocused();
  await expect(page.getByTestId('field-anchor-signature1')).toBeVisible();
  const placed = await box.evaluate((element) => Number((element as HTMLElement).dataset.x));

  await page.keyboard.press('ArrowRight');
  const moved = Math.round((placed + 1) * 100) / 100;
  await expect(box).toHaveAttribute('data-x', String(moved));
  await expect(page.getByTestId('field-anchor-signature1')).toHaveCount(0);

  const request = await downloadRequestJson(page);
  expect(request.fields[0]?.placement).toMatchObject({ kind: 'rect', page: 3, x: moved });
});

test('a number with no place on the visible page says which numbers exist', async ({ page }) => {
  await focusPage3(page);
  await page.keyboard.press('9');
  await expect(page.getByTestId('field-ghost')).toHaveCount(0);
  await expect(page.getByTestId('prepare-status')).toHaveText(/Page 3 has numbered places 1 to 6\./);
});
