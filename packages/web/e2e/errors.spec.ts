import { expect, test, type Page } from '@playwright/test';
import { expectOnlyOwnStaticAssets, watch } from './helpers.ts';
import { buildPacketText, buildPdf } from './pdf.ts';

// Synthetic sentinels: none of them may reach a copied report.
const FILE_NAME = 'SENTINEL-FILE-4821 private agreement.pdf';
const LABEL = 'SENTINEL-LABEL-4821';
const ANCHOR = 'SENTINEL-ANCHOR-4821:';
const SIGNER = 'SENTINEL-SIGNER-4821';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** Open the technical details in `scope`, press "Copy details" and return what the clipboard holds. */
async function copyDetails(page: Page, scope: string): Promise<string> {
  const area = page.getByTestId(scope);
  await area.getByText('Technical details', { exact: true }).first().click();
  const text = area.getByTestId('error-details-text');
  await expect(text).toBeVisible();
  await area.getByTestId('error-details-copy').click();
  await expect(area.getByTestId('error-details-status')).toHaveText('The details are copied.');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await text.inputValue());
  return copied;
}

test('a damaged PDF shows the home error, and its copied details hold the code and the browser but not the file name', async ({ page, baseURL }) => {
  const seen = watch(page);
  await page.goto('/');
  await page.getByTestId('open-pdf-input').setInputFiles({
    name: FILE_NAME,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nthis file was cut off here', 'latin1'),
  });
  await expect(page.getByTestId('home-error-text')).toHaveText('This file could not be read as a PDF.');
  // The details start collapsed.
  await expect(page.getByTestId('error-details-text')).toHaveCount(0);

  const copied = await copyDetails(page, 'home-error');
  const userAgent = await page.evaluate(() => navigator.userAgent);
  expect(copied).toContain('code: invalid-pdf');
  expect(copied).toContain(`userAgent: ${userAgent}`);
  expect(copied).toContain('where: view=home state=empty');
  expect(copied).toMatch(/file: \.pdf \d+ bytes/);
  expect(copied).toMatch(/version: [0-9a-f]{7,12}|version: unknown/);
  expect(copied).not.toContain('SENTINEL');
  expect(copied).not.toContain('private agreement');
  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  // Nothing was sent anywhere.
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});

test('a sign request that cannot be applied shows its details without the anchor, the label, the signer or the file name', async ({ page }) => {
  const pdf = buildPdf([{ texts: [{ text: 'Date:', x: 72, y: 600 }] }]);
  const packet = buildPacketText(pdf, {
    name: FILE_NAME,
    signers: [{ id: 'one', name: SIGNER }],
    fields: [
      {
        id: 'sig',
        type: 'signature',
        label: LABEL,
        assignee: 'human',
        signerId: 'one',
        placement: { kind: 'anchor', text: ANCHOR, width: 180, height: 36 },
      },
    ],
  });
  await page.goto('/');
  await page.getByTestId('open-packet-input').setInputFiles({ name: 'SENTINEL-FILE-4821.signpacket.json', mimeType: 'application/json', buffer: Buffer.from(packet, 'utf8') });
  await expect(page.getByTestId('resolve-error')).toBeVisible();
  // The screen names the field for the person; the report does not.
  await expect(page.getByTestId('resolve-error')).toContainText(LABEL);
  const copied = await copyDetails(page, 'resolve-error');
  expect(copied).toContain('code: anchor-not-found');
  expect(copied).toContain('where: view=sign state=cannot-sign');
  expect(copied).not.toContain('SENTINEL');
});

test('a view that throws while it draws shows the error boundary with its details', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Make the home view throw while it draws: the built script is changed on its way to the page.
  await page.route('**/assets/*.js', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const heading = '"Sign a PDF, or get one ready to sign."';
    await route.fulfill({
      response,
      body: body.includes(heading) ? body.replace(heading, '(()=>{throw new Error("synthetic render failure")})()') : body,
    });
  });
  await page.goto('/');
  const fallback = page.getByTestId('boundary-error');
  await expect(fallback).toBeVisible();
  await expect(fallback.getByRole('heading', { level: 1 })).toHaveText('The page stopped working');
  const copied = await copyDetails(page, 'boundary-error');
  expect(copied).toContain('code: render-error');
  expect(copied).toContain('message: synthetic render failure');
  expect(copied).toMatch(/\n {2}at /);
  expect(errors).toEqual([]);
});
