import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { auditField, auditOf, watch } from './helpers.ts';
import { buildPacketText, buildPdf, rectAt } from './pdf.ts';

/** Type a signature in the capture dialog the guided step opened. */
async function typeInDialog(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId('signature-dialog')).toBeVisible();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill(text);
  await page.getByTestId('signature-apply').click();
  await expect(page.getByTestId('signature-dialog')).toBeHidden();
}

test('two signers sign in turn on one device, and the record keeps both passes', async ({ page }) => {
  const seen = watch(page);
  const pdf = buildPdf([{ texts: [{ text: 'Synthetic two-party form', x: 72, y: 720, size: 16 }] }]);
  const packet = buildPacketText(pdf, {
    signers: [
      { id: 'a', name: 'Signer One' },
      { id: 'b', name: 'Signer Two' },
    ],
    fields: [
      { id: 'ref', type: 'text', label: 'Reference', assignee: 'agent', value: 'REF-0001', placement: rectAt(1, 72, 120, 200, 18) },
      { id: 'sigA', type: 'signature', label: 'First signature', assignee: 'human', signerId: 'a', placement: rectAt(1, 72, 200, 200, 44) },
      { id: 'dateA', type: 'date', label: 'First date', assignee: 'human', signerId: 'a', placement: rectAt(1, 300, 220, 110, 18) },
      { id: 'sigB', type: 'signature', label: 'Second signature', assignee: 'human', signerId: 'b', placement: rectAt(1, 72, 300, 200, 44) },
      { id: 'dateB', type: 'date', label: 'Second date', assignee: 'human', signerId: 'b', placement: rectAt(1, 300, 320, 110, 18) },
    ],
  });
  await page.goto('/');
  await page.getByTestId('open-packet-input').setInputFiles({
    name: 'synthetic.signpacket.json',
    mimeType: 'application/json',
    buffer: Buffer.from(packet, 'utf8'),
  });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');

  // Turn 1: the second signer's fields are locked on the page and in the list.
  await expect(page.getByTestId('signer-turns')).toContainText('Signer One');
  await expect(page.getByTestId('field-box-sigB')).toHaveAttribute('data-locked', 'true');
  await expect(page.getByTestId('review-row-sigB')).toHaveAttribute('data-locked', 'true');
  await expect(page.getByTestId('capture-sigB')).toHaveCount(0);

  // The floating button walks the turn: the prefilled value, the signature, the end. The date starts filled and is skipped.
  const next = page.getByTestId('guide-next');
  await expect(page.getByTestId('guide-step-title')).toHaveText('Check the prefilled values');
  await expect(page.getByTestId('value-ref')).toBeVisible();
  await expect(next).toHaveText('Confirm');
  await next.click();
  await expect(page.getByTestId('guide-position')).toHaveText('Signer One: field 1 of 1');
  await typeInDialog(page, 'Signer One');
  await expect(page.getByTestId('field-done-sigA')).toBeVisible();
  await expect(page.getByTestId('field-done-dateA')).toBeVisible();
  await expect(page.getByTestId('signer-name')).toHaveValue('Signer One');
  await page.getByTestId('consent').check();
  // One block of choices ends the turn; here both sign on this device.
  await expect(page.getByTestId('sign-button')).toHaveText('Download PDF for Signer Two');
  await expect(page.getByTestId('continue-here')).toHaveText('Continue on this device');
  await page.getByTestId('continue-here').click();

  await expect(page.getByTestId('handoff')).toContainText('Hand this device to Signer Two');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await page.getByTestId('handoff-continue').click();

  // Turn 2: a fresh confirmation; the first signer's work is shown, not editable.
  await expect(page.getByTestId('guide-position')).toHaveText('Signer Two: field 1 of 1');
  await expect(page.getByTestId('locked-value-sigA')).toHaveText('Signed');
  await expect(page.getByTestId('locked-value-ref')).toHaveText('REF-0001');
  // The turn opens on the second signer's signature: capture opens by itself, with no reuse of the first signer's.
  await expect(next).toHaveAttribute('data-action', 'capture');
  await expect(page.getByTestId('signature-dialog')).toBeVisible();
  await expect(page.getByTestId('signature-reuse')).toHaveCount(0);
  await typeInDialog(page, 'Signer Two');
  await expect(page.getByTestId('signer-name')).toHaveValue('Signer Two');
  await expect(page.getByTestId('consent')).not.toBeChecked();
  await page.getByTestId('consent').check();
  await expect(page.getByTestId('sign-button')).toHaveText('Sign as Signer Two');
  await page.getByTestId('sign-button').click();

  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');
  await expect(page.getByTestId('audit-pass-a')).toContainText('Signer One');
  await expect(page.getByTestId('audit-pass-b')).toContainText('Signer Two');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-signed').click()]);
  const audit = await auditOf(await readFile(await download.path()));
  expect(audit.passes?.map((pass) => [pass.signerId, pass.signer.name, pass.fieldIds])).toEqual([
    ['a', 'Signer One', ['sigA', 'dateA']],
    ['b', 'Signer Two', ['sigB', 'dateB']],
  ]);
  expect(auditField(audit, 'sigA').signerId).toBe('a');
  expect(auditField(audit, 'sigB').signerId).toBe('b');
  expect(seen.problems).toEqual([]);
});
