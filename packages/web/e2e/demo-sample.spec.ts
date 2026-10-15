import { expect, test } from '@playwright/test';
import { expectOnlyOwnStaticAssets, showAllFields, watch } from './helpers.ts';

/**
 * "Try the sample agreement" opens the agent demo (docs/demo.md): the NDA with
 * no form fields and the five demo fields of /demo-request.json, with plain
 * labels and demo values. The sign view keeps empty boxes empty.
 */
test('the sample opens the demo: five plain fields, three for the human, and no label inside an empty box', async ({ page, baseURL }) => {
  const seen = watch(page);
  await page.goto('/');
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('document-name')).toHaveText('demo-nda.pdf');
  await expect(page.getByTestId('field-count')).toHaveText('5');
  await expect(page.getByTestId('demo-notice')).toContainText('Nothing is uploaded');
  // The demo PDF has no form fields, so no other blank is offered as a field.
  await expect(page.getByTestId('use-acro-fields')).toHaveCount(0);
  // The paste box stays closed: the person did not paste anything.
  await expect(page.getByTestId('request-paste')).not.toHaveAttribute('open', '');

  await page.getByTestId('continue-to-sign').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await showAllFields(page);

  const labels: Record<string, string> = {
    party_a: 'Party A',
    party_b: 'Party B',
    signature: 'Signature',
    date: 'Date',
    print_name: 'Print name',
  };
  for (const [id, label] of Object.entries(labels)) {
    await expect(page.getByTestId(`review-row-${id}`).locator('.review-label, label').first()).toContainText(label);
  }
  // The agent filled the two party names with demo values. The human has three
  // fields: the signature, the date (today's, already filled) and the print
  // name (a demo value to keep or change). With the signer name and the
  // confirmation box, four items wait.
  await expect(page.getByTestId('prefilled-party_a')).toBeVisible();
  await expect(page.getByTestId('prefilled-party_b')).toBeVisible();
  await expect(page.getByTestId('capture-signature')).toBeVisible();
  await expect(page.getByTestId('done-date')).toBeVisible();
  await expect(page.getByTestId('keep-print_name')).toBeVisible();
  await expect(page.getByTestId('progress-text')).toHaveText('0 of 4 required items done');
  await expect(page.getByTestId('field-box-party_a')).toContainText('Example Co.');
  await expect(page.getByTestId('field-box-party_b')).toContainText('Sample Partner Co.');

  // An empty box shows no label: the side panel names it.
  await expect(page.getByTestId('field-box-signature').locator('.field-content')).toHaveText('');

  expectOnlyOwnStaticAssets(seen, baseURL!);
  expect(seen.problems).toEqual([]);
});
