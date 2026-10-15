import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { dropFiles, expectOnlyOwnStaticAssets, fieldRect, readSample, watch } from './helpers.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function requestFor(sample: Buffer, overrides: { sha256?: string; placement?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    version: 1,
    document: { name: 'sample-nda.pdf', sha256: overrides.sha256 ?? sha256(sample) },
    fields: [
      {
        id: 'party-name',
        type: 'text',
        label: 'Party A name',
        assignee: 'human',
        placement: overrides.placement ?? { kind: 'rect', page: 3, x: 140, y: 142, width: 170, height: 16 },
      },
    ],
  });
}

test('drop a PDF on the home drop zone to open it', async ({ page, baseURL }) => {
  const seen = watch(page);
  const sample = await readSample();
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
  await dropFiles(page, 'drop-zone', [{ name: 'dropped-agreement.pdf', type: 'application/pdf', base64: sample.toString('base64') }]);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('document-name')).toHaveText('dropped-agreement.pdf');
  await expect(page.getByTestId('pdf-page-3')).toBeVisible();
  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});

test('drop a PDF together with its request file to go straight to signing', async ({ page }) => {
  const seen = watch(page);
  const sample = await readSample();
  await page.goto('/');
  await dropFiles(page, 'drop-zone', [
    { name: 'sample-nda.signrequest.json', type: 'application/json', base64: Buffer.from(requestFor(sample)).toString('base64') },
    { name: 'sample-nda.pdf', type: 'application/pdf', base64: sample.toString('base64') },
  ]);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  expect(await fieldRect(page, 'party-name')).toEqual({ page: 3, x: 140, y: 142, width: 170, height: 16 });
  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
});

test('drop something that is not a PDF: an announced error, and the page stays', async ({ page }) => {
  await page.goto('/');
  await dropFiles(page, 'drop-zone', [{ name: 'holiday.txt', type: 'text/plain', base64: Buffer.from('plain words').toString('base64') }]);
  await expect(page.getByTestId('home-error')).toContainText('“holiday.txt” is not a PDF');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
});

test('a file over the size limit is refused with the limit in the message', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/');
  // 101 MB of zero bytes, made inside the page: nothing that large is sent to the browser.
  await dropFiles(page, 'drop-zone', [{ name: 'huge-scan.pdf', type: 'application/pdf', zeroBytes: 101 * 1024 * 1024 }]);
  const error = page.getByTestId('home-error');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('home-error-text')).toHaveText('“huge-scan.pdf” is too large (101 MB). The limit is 100 MB.');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');

  // The page still works afterwards.
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
});

async function openPair(page: Page, sample: Buffer, request: string): Promise<void> {
  await page.goto('/');
  await page.getByText('A PDF with a separate request file', { exact: true }).click();
  await page.getByTestId('pair-pdf-input').setInputFiles({ name: 'sample-nda.pdf', mimeType: 'application/pdf', buffer: sample });
  await page.getByTestId('pair-request-input').setInputFiles({ name: 'request.json', mimeType: 'application/json', buffer: Buffer.from(request) });
  await page.getByTestId('pair-open').click();
}

test('a request written for another PDF stops at the error screen', async ({ page, baseURL }) => {
  const seen = watch(page);
  const sample = await readSample();
  await openPair(page, sample, requestFor(sample, { sha256: 'a'.repeat(64) }));

  const screen = page.getByTestId('resolve-error');
  await expect(screen).toBeVisible();
  await expect(screen).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('resolve-error-text')).toHaveText(
    'The request was written for a different version of this PDF. Ask the preparer for the matching file.',
  );
  // Nothing can be signed from here.
  await expect(page.getByTestId('sign-button')).toHaveCount(0);
  await expect(page.getByTestId('signer-name')).toHaveCount(0);
  await expect(page.getByTestId('app-root')).not.toHaveAttribute('data-state', 'signed');

  await page.getByTestId('start-over').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});

test('a request whose anchor text is not in the PDF names the field on the error screen', async ({ page }) => {
  const seen = watch(page);
  const sample = await readSample();
  const placement = { kind: 'anchor', text: 'Words That Are Not Printed Anywhere', width: 170, height: 16 };
  await openPair(page, sample, requestFor(sample, { placement }));

  const screen = page.getByTestId('resolve-error');
  await expect(screen).toBeVisible();
  await expect(page.getByTestId('resolve-error-text')).toHaveText(
    'The text this field should sit next to was not found in the document.',
  );
  await expect(screen).toContainText('Field: Party A name');
  await expect(page.getByTestId('sign-button')).toHaveCount(0);
  // There is no prepare view to go back to when the job came from files.
  await expect(page.getByTestId('back-to-prepare')).toHaveCount(0);
  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
});
