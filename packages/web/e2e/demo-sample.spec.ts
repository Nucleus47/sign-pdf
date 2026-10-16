import { expect, test } from '@playwright/test';
import { drawSignature, expectOnlyOwnStaticAssets, showAllFields, watch } from './helpers.ts';

/**
 * "Try the sample agreement" opens the agent demo (docs/demo.md): the NDA with
 * no form fields and the five demo fields of /demo-request.json, with plain
 * labels and demo values. The sign view keeps empty boxes empty.
 */
test('the sample opens the demo: five plain fields, two steps for the signer, and no label inside an empty box', async ({ page, baseURL }) => {
  const seen = watch(page);
  // Record whether the empty field list ever shows while the sample loads (#16).
  await page.addInitScript(() => {
    const flags = window as unknown as { sawNoFields?: boolean };
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="no-fields"]')) flags.sawNoFields = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/');
  await expect(page.getByTestId('home-agent-hint')).toBeVisible();
  await expect(page.getByTestId('home-agent-hint')).toHaveText('AI agent? Read /skill.md first.');
  await expect(page.getByTestId('skill-link')).toHaveAttribute('href', '/skill.md');
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('document-name')).toHaveText('demo-nda.pdf');
  const ready = await (await page.request.get('/demo-request.json')).json();
  await expect(page.getByTestId('field-count')).toHaveText(String(ready.fields.length));
  expect(ready.fields.map((field: { id: string }) => field.id).sort()).toEqual([
    'date', 'party_a', 'party_b', 'print_name', 'signature',
  ]);
  for (const blank of ['Effective Date', 'confidentiality', 'agreement duration', 'Party B’s']) {
    await expect(page.getByTestId('demo-notice')).toContainText(blank);
    expect(ready.note).toContain(blank);
  }
  await expect(page.getByTestId('demo-notice')).toContainText('Nothing is uploaded');
  // The demo PDF has no form fields, so no other blank is offered as a field.
  await expect(page.getByTestId('use-acro-fields')).toHaveCount(0);
  // The paste box stays closed: the person did not paste anything.
  await expect(page.getByTestId('request-paste')).not.toHaveAttribute('open', '');
  // The field list never said "No fields yet" while the demo request loaded.
  expect(await page.evaluate(() => (window as unknown as { sawNoFields?: boolean }).sawNoFields ?? false)).toBe(false);

  await expect(page.getByTestId('app-bar-sign')).toBeVisible();
  await expect(page.getByTestId('header-continue-to-sign')).toBeVisible();
  await page.getByTestId('app-bar-sign').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await expect(page.getByTestId('app-bar-prepare')).toBeVisible();
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
  // The agent filled the two party names, the print name and the signer name
  // with demo values; the date is today's. The signer has two things to do:
  // sign, and tick the confirmation box. No name is asked twice (#16).
  await expect(page.getByTestId('prefilled-party_a')).toBeVisible();
  await expect(page.getByTestId('prefilled-party_b')).toBeVisible();
  await expect(page.getByTestId('prefilled-print_name')).toBeVisible();
  await expect(page.getByTestId('capture-signature')).toBeVisible();
  await expect(page.getByTestId('done-date')).toBeVisible();
  await expect(page.getByTestId('signer-name')).toHaveValue('Your Name');
  await expect(page.getByTestId('progress-text')).toHaveText('0 of 2 required items done');
  await expect(page.getByTestId('sign-agent-guard')).toBeVisible();
  await expect(page.getByTestId('sign-agent-guard')).toHaveText(
    'Only the person who signs can press Sign. An AI agent must stop here and ask its user.',
  );
  await expect(page.getByTestId('sign-button')).toBeDisabled();
  await expect(page.getByTestId('field-box-party_a')).toContainText('Example Co.');
  await expect(page.getByTestId('field-box-party_b')).toContainText('Sample Partner Co.');

  // An empty box shows no label: the side panel names it.
  await expect(page.getByTestId('field-box-signature').locator('.field-content')).toHaveText('');

  // The count reaches N of N exactly when the Sign button turns on.
  await page.getByTestId('capture-signature').click();
  await drawSignature(page);
  await page.getByTestId('signature-apply').click();
  await expect(page.getByTestId('signature-dialog')).toBeHidden();
  await expect(page.getByTestId('progress-text')).toHaveText('1 of 2 required items done');
  await expect(page.getByTestId('sign-button')).toBeDisabled();
  await page.getByTestId('consent').check();
  await expect(page.getByTestId('progress-text')).toHaveText('2 of 2 required items done');
  await expect(page.getByTestId('sign-button')).toBeEnabled();

  expectOnlyOwnStaticAssets(seen, baseURL!);
  expect(seen.problems).toEqual([]);
});

test('sample fit follows pane width until the person chooses a zoom', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/');
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('field-box-party_a')).toBeVisible();
  const zoom = page.getByTestId('zoom-value');
  const initial = await zoom.textContent();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(zoom).not.toHaveText(initial!);
  await page.getByTestId('zoom-in').click();
  const manual = await zoom.textContent();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(zoom).toHaveText(manual!);
  await page.getByTestId('zoom-fit').click();
  await expect(zoom).not.toHaveText(manual!);
  const fitted = await zoom.textContent();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(zoom).not.toHaveText(fitted!);
});
