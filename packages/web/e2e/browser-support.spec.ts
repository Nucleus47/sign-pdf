import { expect, test } from '@playwright/test';

test('an out-of-date browser gets a banner that says to update it', async ({ page }) => {
  // structuredClone is one of the features that nothing supplies when it is missing.
  await page.addInitScript(() => {
    Reflect.deleteProperty(globalThis, 'structuredClone');
  });
  await page.goto('/');
  const banner = page.getByTestId('browser-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toContainText('This browser is out of date. Update it, then open this page again.');
  await expect(banner).toContainText('Missing: structuredClone.');
  // The app is still there below the banner.
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
});

test('no banner when only shimmed features are missing, but the report still names them', async ({ page }) => {
  await page.addInitScript(() => {
    const stream = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
    delete stream[Symbol.asyncIterator];
    delete stream.values;
  });
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('browser-banner')).toHaveCount(0);
  // The probe ran before the shim: the report lists the feature as missing.
  await page.getByTestId('open-pdf-input').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a pdf') });
  await page.getByTestId('home-error').getByText('Technical details', { exact: true }).click();
  await expect(page.getByTestId('error-details-text')).toHaveValue(/features missing: ReadableStream async iteration/);
  // The shim is in place afterwards.
  expect(await page.evaluate(() => typeof (ReadableStream.prototype as unknown as Record<PropertyKey, unknown>)[Symbol.asyncIterator])).toBe('function');
});
