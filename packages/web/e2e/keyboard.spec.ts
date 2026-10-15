import { expect, test, type Locator, type Page } from '@playwright/test';
import { chooseSamplePdfByKeyboard, expectOnlyOwnStaticAssets, SIGNER, watch } from './helpers.ts';

/** Tab forward until the wanted control has focus. No pointer is used in this file. */
async function tabTo(page: Page, target: Locator, limit = 200): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('control was not reachable with Tab');
}

async function typeInto(page: Page, target: Locator, text: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
}

test('the whole flow works with the keyboard alone', async ({ page, baseURL }) => {
  const seen = watch(page);
  await page.goto('/');
  await tabTo(page, page.getByTestId('open-pdf-input'));
  await chooseSamplePdfByKeyboard(page);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('pdf-page-3')).toBeVisible();

  // Add a signature field by form.
  await tabTo(page, page.getByTestId('add-type'));
  await page.getByTestId('add-type').selectOption('signature'); // native select: keyboard-operable
  await typeInto(page, page.getByTestId('add-label'), 'Party A signature');
  await typeInto(page, page.getByTestId('add-page'), '3');
  await typeInto(page, page.getByTestId('add-x'), '190');
  await typeInto(page, page.getByTestId('add-y'), '92');
  await tabTo(page, page.getByTestId('add-field'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('field-count')).toHaveText('1');

  // A text field, then remove it from the page with Delete and bring it back with Undo.
  await page.keyboard.press('Shift+Tab');
  await tabTo(page, page.getByTestId('add-type'));
  await page.getByTestId('add-type').selectOption('text');
  await tabTo(page, page.getByTestId('add-field'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('field-count')).toHaveText('2');

  // Focus the field's box from its row, then nudge and resize with the keyboard.
  await tabTo(page, page.getByTestId('field-show-text1'));
  await page.keyboard.press('Enter');
  const box = page.getByTestId('field-box-text1');
  await expect(box).toBeFocused();
  const x = Number(await box.getAttribute('data-x'));
  const y = Number(await box.getAttribute('data-y'));
  const width = Number(await box.getAttribute('data-width'));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Alt+ArrowRight');
  expect(Number(await box.getAttribute('data-x'))).toBe(x + 1);
  expect(Number(await box.getAttribute('data-y'))).toBe(y + 10);
  expect(Number(await box.getAttribute('data-width'))).toBe(width + 1);

  await page.keyboard.press('Delete');
  await expect(page.getByTestId('field-count')).toHaveText('1');
  await tabTo(page, page.getByTestId('undo'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('field-count')).toHaveText('2');
  // Remove it again for good: this flow signs with the signature field only.
  await tabTo(page, page.getByTestId('field-remove-text1'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('field-count')).toHaveText('1');

  await tabTo(page, page.getByTestId('continue-to-sign'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');

  // The floating button drives the walk. On the signature it reads "Sign here" and opens capture.
  await tabTo(page, page.getByTestId('guide-next'));
  await expect(page.getByTestId('guide-next')).toHaveText('Sign here');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('signature-dialog')).toBeVisible();
  await expect(page.getByTestId('signature-tab-draw')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('signature-tab-type')).toHaveAttribute('aria-selected', 'true');
  await typeInto(page, page.getByTestId('signature-typed-input'), SIGNER);

  // Focus stays inside the dialog, and Escape closes it and returns focus.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('signature-dialog')).toBeHidden();
  await expect(page.getByTestId('guide-next')).toBeFocused();

  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await typeInto(page, page.getByTestId('signature-typed-input'), SIGNER);
  await tabTo(page, page.getByTestId('signature-apply'));
  await page.keyboard.press('Enter');
  // The signature finishes its step: the last step has the focus.
  await expect(page.getByTestId('guide-step-title')).toBeFocused();
  await expect(page.getByTestId('field-done-signature1')).toBeVisible();

  await typeInto(page, page.getByTestId('signer-name'), SIGNER);
  await tabTo(page, page.getByTestId('consent'));
  await page.keyboard.press('Space');
  await expect(page.getByTestId('sign-button')).toBeEnabled();

  // Enter in a text field never signs.
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('signer-name')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');

  await tabTo(page, page.getByTestId('sign-button'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');
  await expect(page.getByTestId('signed-sha256')).toHaveText(/^[0-9a-f]{64}$/);

  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});
