import { expect, test } from '@playwright/test';
import { addFieldByForm, openSample, showAllFields, SIGNER } from './helpers.ts';

test('a value that cannot be drawn is reported next to its field, with the way to fix it', async ({ page }) => {
  await openSample(page);
  await addFieldByForm(page, { type: 'text', label: 'Short box', page: 3, x: 140, y: 142, width: 40, height: 8 });
  await page.getByTestId('field-required-text1').uncheck();
  await addFieldByForm(page, { type: 'signature', label: 'Party A signature', page: 3, x: 190, y: 92, width: 160, height: 30 });
  await page.getByTestId('continue-to-sign').click();
  await showAllFields(page);

  await page.getByTestId('capture-signature1').click();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill(SIGNER);
  await page.getByTestId('signature-apply').click();
  await page.getByTestId('signer-name').fill(SIGNER);
  await page.getByTestId('consent').check();
  await expect(page.getByTestId('sign-button')).toBeEnabled();

  // Too long for a 40 x 8 point box.
  await page.getByTestId('value-text1').fill('A very long company name that cannot fit in a tiny box');
  await expect(page.getByTestId('value-problem-text1')).toContainText('too long for its box');
  await expect(page.getByTestId('sign-button')).toBeDisabled();

  // Enlarging the box on the page fixes it: the check runs again after a resize.
  const box = page.getByTestId('field-box-text1');
  await box.focus();
  for (let i = 0; i < 30; i += 1) await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(page.getByTestId('value-problem-text1')).toHaveCount(0);
  await expect(page.getByTestId('sign-button')).toBeEnabled();

  // Characters the bundled font lacks.
  await page.getByTestId('value-text1').fill('山田 Ltd');
  await expect(page.getByTestId('value-problem-text1')).toContainText('cannot be printed');
  await expect(page.getByTestId('sign-button')).toBeDisabled();

  // A zero-width space is removed when the value is drawn.
  await page.getByTestId('value-text1').fill('Example​ Company');
  await expect(page.getByTestId('sign-button')).toBeEnabled();
  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');
  // The signed screen shows the value as the record has it (as drawn), not as typed.
  await expect(page.getByTestId('audit-human-filled')).toHaveText(/Short box: Example Company$/);
});
