import { expect, test } from '@playwright/test';
import { addFieldByForm, auditField, auditOf, expectOnlyOwnStaticAssets, fieldRect, inkFraction, makeSignaturePng, openSample, showAllFields, signAndDownload, SIGNER, watch } from './helpers.ts';

// A stretch of page 3 below the signature blocks with nothing printed on it.
const BLANK = { page: 3, x: 100, y: 450, width: 200, height: 60 } as const;

test('upload an image as the signature', async ({ page, baseURL }) => {
  const seen = watch(page);
  await openSample(page);
  await addFieldByForm(page, { type: 'signature', label: 'Party A signature', ...BLANK });
  expect(await inkFraction(page, BLANK)).toBe(0);

  await page.getByTestId('continue-to-sign').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await showAllFields(page);
  await page.getByTestId('capture-signature1').click();
  await page.getByTestId('signature-tab-upload').click();
  const input = page.getByTestId('signature-upload-input');
  const apply = page.getByTestId('signature-apply');
  await expect(apply).toBeDisabled();

  // Not an image at all.
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await expect(page.getByTestId('signature-error')).toHaveText('Choose a PNG or JPEG image.');
  await expect(apply).toBeDisabled();

  // Named like an image, but the content is not one.
  // It is refused when chosen: no broken preview, nothing to apply.
  await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') });
  await expect(page.getByTestId('signature-error')).toHaveText('That image could not be read. Choose a PNG or JPEG file.');
  await expect(page.getByTestId('signature-dialog').locator('img.upload-preview')).toHaveCount(0);
  await expect(apply).toBeDisabled();

  // A real image, generated here.
  await input.setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: makeSignaturePng() });
  await expect(page.getByTestId('signature-error')).toHaveCount(0);
  await expect(page.getByTestId('signature-dialog').locator('img.upload-preview')).toBeVisible();
  await expect(page.getByTestId('signature-remove-paper')).toBeChecked();
  await apply.click();
  await expect(page.getByTestId('signature-dialog')).toBeHidden();
  await expect(page.getByTestId('signature-preview-signature1')).toBeVisible();

  const signed = await signAndDownload(page);
  const audit = await auditOf(signed);
  const entry = auditField(audit, 'signature1');
  expect(entry.signatureMethod).toBe('uploaded');
  expect(entry.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(entry.rect).toEqual(BLANK);
  await expect(page.getByTestId('audit-signed')).toContainText('Party A signature');

  // The image is drawn inside the field's rectangle on the signed page, and not beside it.
  await expect.poll(() => inkFraction(page, BLANK)).toBeGreaterThan(0.01);
  expect(await inkFraction(page, { ...BLANK, y: BLANK.y + BLANK.height + 4, height: 40 })).toBe(0);

  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});

test('initials, and the same signature used for a second signature field', async ({ page, baseURL }) => {
  const seen = watch(page);
  await openSample(page);
  await addFieldByForm(page, { type: 'signature', label: 'First signature', ...BLANK, width: 160, height: 40 });
  await addFieldByForm(page, { type: 'signature', label: 'Second signature', ...BLANK, x: 340, width: 160, height: 40 });
  await addFieldByForm(page, { type: 'initials', label: 'Page initials', page: 3, x: 100, y: 540, width: 64, height: 32 });
  const initialsRect = await fieldRect(page, 'initials1');
  expect(await inkFraction(page, initialsRect)).toBe(0);

  await page.getByTestId('continue-to-sign').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await showAllFields(page);
  await expect(page.getByTestId('field-box-initials1')).toContainText('Initial here');
  await page.getByTestId('signer-name').fill(SIGNER);

  // First signature: typed. Nothing to reuse yet.
  await page.getByTestId('capture-signature1').click();
  await expect(page.getByTestId('signature-reuse')).toHaveCount(0);
  await page.getByTestId('signature-tab-type').click();
  await expect(page.getByTestId('signature-typed-input')).toHaveValue(SIGNER);
  await page.getByTestId('signature-apply').click();
  await expect(page.getByTestId('signature-preview-signature1')).toBeVisible();

  // Initials: a signature is not offered in place of initials; the name's initials are suggested.
  await page.getByTestId('capture-initials1').click();
  await expect(page.getByTestId('signature-dialog')).toBeVisible();
  await expect(page.getByTestId('signature-reuse')).toHaveCount(0);
  await page.getByTestId('signature-tab-type').click();
  await expect(page.getByTestId('signature-typed-input')).toHaveValue('TS');
  await page.getByTestId('signature-apply').click();
  await expect(page.getByTestId('signature-preview-initials1')).toBeVisible();
  await expect(page.getByTestId('sign-button')).toBeDisabled();

  // Second signature: the first one is offered, and one press uses it.
  await page.getByTestId('capture-signature2').click();
  await expect(page.getByTestId('signature-reuse')).toBeVisible();
  await page.getByTestId('signature-reuse').click();
  await expect(page.getByTestId('signature-dialog')).toBeHidden();
  await expect(page.getByTestId('signature-preview-signature2')).toBeVisible();

  const signed = await signAndDownload(page);
  const audit = await auditOf(signed);
  const first = auditField(audit, 'signature1');
  const second = auditField(audit, 'signature2');
  const initials = auditField(audit, 'initials1');
  expect(first.signatureMethod).toBe('typed');
  expect(second.signatureMethod).toBe('typed');
  expect(first.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(second.signatureSha256).toBe(first.signatureSha256);
  expect(initials.type).toBe('initials');
  expect(initials.signatureMethod).toBe('typed');
  expect(initials.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(initials.signatureSha256).not.toBe(first.signatureSha256);
  expect(initials.rect).toEqual(initialsRect);
  await expect(page.getByTestId('audit-signed')).toContainText('Page initials');
  await expect(page.getByTestId('audit-signed')).toContainText('Second signature');

  // All three are drawn on the signed page.
  await expect.poll(() => inkFraction(page, initialsRect)).toBeGreaterThan(0.01);
  expect(await inkFraction(page, first.rect)).toBeGreaterThan(0.01);
  expect(await inkFraction(page, second.rect)).toBeGreaterThan(0.01);

  expect(seen.problems, 'console errors and CSP violations').toEqual([]);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});
