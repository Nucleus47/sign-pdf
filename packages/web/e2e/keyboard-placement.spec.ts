import { expect, test, type Locator, type Page } from '@playwright/test';

/** Tab forward until the wanted control has focus. No pointer is used in this file. */
async function tabTo(page: Page, target: Locator, limit = 200): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('control was not reachable with Tab');
}

async function position(target: Locator): Promise<{ x: number; y: number; page: number }> {
  return target.evaluate((element) => ({
    x: Number(element.getAttribute('data-x')),
    y: Number(element.getAttribute('data-y')),
    page: Number(element.closest('[data-page]')?.getAttribute('data-page')),
  }));
}

async function openSampleByKeyboard(page: Page): Promise<Locator> {
  await page.goto('/');
  await tabTo(page, page.getByTestId('load-sample'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('pdf-page-3')).toBeVisible();
  const region = page.getByRole('group', { name: 'Pages' });
  await tabTo(page, region);
  return region;
}

test('places a field, fine-tunes it and undoes the move with the keyboard alone', async ({ page }) => {
  const region = await openSampleByKeyboard(page);
  const ghost = page.getByTestId('field-ghost');
  const status = page.getByTestId('prepare-status');

  // S starts a signature box in the middle of the visible page; T changes its type in place.
  await page.keyboard.press('s');
  await expect(ghost).toHaveAttribute('data-type', 'signature');
  await expect(status).toContainText('Placing a signature field');
  const start = await position(ghost);
  await page.keyboard.press('t');
  await expect(ghost).toHaveAttribute('data-type', 'text');
  await page.keyboard.press('s');

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(ghost).toHaveAttribute('data-x', String(start.x + 1));
  await expect(ghost).toHaveAttribute('data-y', String(start.y + 10));
  await expect(page.getByTestId('field-count')).toHaveText('0');

  // Enter adds it where the box is and focuses it.
  await page.keyboard.press('Enter');
  await expect(ghost).toHaveCount(0);
  await expect(page.getByTestId('field-count')).toHaveText('1');
  const box = page.getByTestId('field-box-signature1');
  await expect(box).toBeFocused();
  expect(await position(box)).toEqual({ x: start.x + 1, y: start.y + 10, page: start.page });

  // A burst of nudges is one undo step; the next undo removes the field.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(box).toHaveAttribute('data-x', String(start.x + 4));
  await expect(status).toContainText('Moved signature1.');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(box).toHaveAttribute('data-x', String(start.x + 1));
  await expect(page.getByTestId('field-count')).toHaveText('1');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('field-count')).toHaveText('0');
  await expect(region).toBeVisible();
});

test('escape cancels a placement, brackets walk the fields and ? shows the shortcuts', async ({ page }) => {
  const region = await openSampleByKeyboard(page);
  const ghost = page.getByTestId('field-ghost');

  await page.keyboard.press('c');
  await expect(ghost).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ghost).toHaveCount(0);
  await expect(page.getByTestId('prepare-status')).toHaveText(/Placement cancelled\./);

  // Two fields from the keyboard: the second starts just below the first.
  await expect(region).toBeFocused();
  await page.keyboard.press('t');
  await page.keyboard.press('Enter');
  await page.keyboard.press('d');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('field-count')).toHaveText('2');
  const text = await position(page.getByTestId('field-box-text1'));
  const date = await position(page.getByTestId('field-box-date1'));
  expect(date.y).toBeGreaterThan(text.y);
  await expect(page.getByTestId('field-box-date1')).toBeFocused();

  // ] and [ go through the fields in reading order.
  await page.keyboard.press(']');
  await expect(page.getByTestId('field-box-text1')).toBeFocused();
  await page.keyboard.press('[');
  await expect(page.getByTestId('field-box-date1')).toBeFocused();

  // A switches who fills the focused field.
  await page.keyboard.press('a');
  await expect(page.getByTestId('field-assignee-date1')).toHaveValue('agent');
  await expect(page.getByTestId('prepare-status')).toContainText('filled by the preparer');
  // The change is one undo step.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('field-assignee-date1')).toHaveValue('human');
  await expect(page.getByTestId('field-count')).toHaveText('2');

  // ? opens the shortcut list; Escape closes it and gives focus back.
  await page.keyboard.press('?');
  const dialog = page.getByTestId('shortcuts-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('field-box-date1')).toBeFocused();
});

test('letter keys do nothing while typing in a box', async ({ page }) => {
  await openSampleByKeyboard(page);
  const label = page.getByTestId('add-label');
  await tabTo(page, label);
  await page.keyboard.type('Tsdci?');
  await expect(label).toHaveValue('Tsdci?');
  await expect(page.getByTestId('field-ghost')).toHaveCount(0);
  await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);
});

test('A needs a focused field box, and focusing a field box cancels a placement', async ({ page }) => {
  const region = await openSampleByKeyboard(page);
  const ghost = page.getByTestId('field-ghost');
  const status = page.getByTestId('prepare-status');

  await page.keyboard.press('t');
  await page.keyboard.press('Enter');
  const box = page.getByTestId('field-box-text1');
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute('data-selected', 'true');

  // Focus goes back to the pages; the old selection stays, but A must not change it.
  await region.focus();
  await expect(box).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('a');
  await expect(status).toContainText('Focus a field first, then press A.');
  await expect(page.getByTestId('field-assignee-text1')).toHaveValue('human');

  // A placement box is cancelled, with a status message, when focus moves to a field box.
  await page.keyboard.press('d');
  await expect(ghost).toBeVisible();
  await box.focus();
  await expect(ghost).toHaveCount(0);
  await expect(status).toContainText('Placement cancelled.');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('field-count')).toHaveText('1');

  // ... and when focus leaves the pages.
  await region.focus();
  await page.keyboard.press('d');
  await expect(ghost).toBeVisible();
  await page.getByTestId('show-shortcuts').focus();
  await expect(ghost).toHaveCount(0);
  await expect(status).toContainText('Placement cancelled.');
});
