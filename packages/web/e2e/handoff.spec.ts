import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { readHandoffPdf } from '@sign-pdf/core';
import { auditField, auditOf, watch } from './helpers.ts';
import { buildPacketText, buildPdf, rectAt } from './pdf.ts';

const packet = () =>
  buildPacketText(buildPdf([{ texts: [{ text: 'Synthetic two-party form', x: 72, y: 720, size: 16 }] }]), {
    name: 'two-party.pdf',
    signers: [
      { id: 'a', name: 'Signer One' },
      { id: 'b', name: 'Signer Two' },
    ],
    fields: [
      { id: 'ref', type: 'text', label: 'Reference', assignee: 'agent', value: 'REF-0001', placement: rectAt(1, 72, 120, 200, 18) },
      { id: 'sigA', type: 'signature', label: 'First signature', assignee: 'human', signerId: 'a', placement: rectAt(1, 72, 200, 200, 44) },
      { id: 'sigB', type: 'signature', label: 'Second signature', assignee: 'human', signerId: 'b', placement: rectAt(1, 72, 300, 200, 44) },
    ],
  });

async function typeInDialog(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId('signature-dialog')).toBeVisible();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill(text);
  await page.getByTestId('signature-apply').click();
  await expect(page.getByTestId('signature-dialog')).toBeHidden();
}

test('the first signer downloads a hand-off PDF; the second opens it on another device and signs', async ({ browser }) => {
  // Device A: the first signer.
  const deviceA = await browser.newContext({ acceptDownloads: true });
  const pageA = await deviceA.newPage();
  const seenA = watch(pageA);
  await pageA.goto('/');
  await pageA.getByTestId('open-packet-input').setInputFiles({
    name: 'synthetic.signpacket.json',
    mimeType: 'application/json',
    buffer: Buffer.from(packet(), 'utf8'),
  });
  await expect(pageA.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await pageA.getByTestId('guide-next').click();
  await typeInDialog(pageA, 'Signer One');
  await pageA.getByTestId('consent').check();
  // The floating button shows the choices; it downloads nothing by itself.
  // This server has no relay, so the download is the first choice and no email is offered.
  await pageA.getByTestId('guide-send').click();
  await expect(pageA.getByTestId('sign-button')).toBeFocused();
  await expect(pageA.getByTestId('turn-choices')).toBeInViewport();
  await expect(pageA.getByTestId('next-email')).toHaveCount(0);
  await expect(pageA.getByTestId('email-handoff')).toHaveCount(0);
  await expect(pageA.getByTestId('sign-button')).toHaveText('Download PDF for Signer Two');
  const [download] = await Promise.all([pageA.waitForEvent('download'), pageA.getByTestId('sign-button').click()]);
  // The name says the stage: signed by 1 of 2.
  expect(download.suggestedFilename()).toBe('two-party-signed-1-of-2-handoff.pdf');
  await expect(pageA.getByTestId('handoff-sent')).toContainText('Send this file to Signer Two');
  await expect(pageA.getByTestId('handoff-warning')).toHaveText('This file holds your signature. Send it only to Signer Two.');
  const message = pageA.getByTestId('handoff-copy-text');
  await expect(message).toHaveValue(/^Hi Signer Two,\n/);
  await expect(message).toHaveValue(/open the attached file: two-party-signed-1-of-2-handoff\.pdf\n/);
  const handoff = await readFile(await download.path());
  expect(seenA.problems).toEqual([]);
  await deviceA.close();

  // The file carries the original and the first signer's turn.
  const contents = await readHandoffPdf(new Uint8Array(handoff));
  expect(contents?.passes.map((pass) => pass.signerId)).toEqual(['a']);

  // Device B: a fresh browser, with nothing from device A.
  const deviceB = await browser.newContext({ acceptDownloads: true });
  const pageB = await deviceB.newPage();
  const seenB = watch(pageB);

  // Verify first: a hand-off PDF is not final, and says who is still to sign.
  await pageB.goto('/');
  await pageB.getByTestId('go-verify').click();
  await pageB.getByTestId('verify-input').setInputFiles({ name: 'two-party-signed-1-of-2-handoff.pdf', mimeType: 'application/pdf', buffer: handoff });
  await expect(pageB.getByTestId('verify-handoff')).toContainText('It is not final until every signer has signed.');
  await expect(pageB.getByTestId('verify-handoff-signed')).toContainText('Signer One');
  await expect(pageB.getByTestId('verify-handoff-pending')).toContainText('Signer Two');

  // The next signer opens it from "Did you receive a file to sign?". The app finds the hand-off
  // by its attachment, not by its name: a renamed file opens too.
  await pageB.goto('/');
  await pageB.getByTestId('open-packet-input').setInputFiles({ name: 'renamed.pdf', mimeType: 'application/pdf', buffer: handoff });
  await expect(pageB.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await expect(pageB.getByTestId('guide-position')).toHaveText('Signer Two: field 1 of 1');
  await expect(pageB.getByTestId('field-box-sigA')).toHaveAttribute('data-locked', 'true');
  await expect(pageB.getByTestId('locked-value-sigA')).toHaveText('Signed');
  // The document shown is the original, not the hand-off pages with their "NOT FINAL" strip.
  await expect(pageB.locator('.textLayer', { hasText: 'NOT FINAL' })).toHaveCount(0);
  await expect(pageB.locator('.textLayer', { hasText: 'Synthetic two-party form' }).first()).toBeAttached();

  await pageB.getByTestId('guide-next').click();
  await typeInDialog(pageB, 'Signer Two');
  await pageB.getByTestId('consent').check();
  await expect(pageB.getByTestId('sign-button')).toHaveText('Sign as Signer Two');
  await pageB.getByTestId('sign-button').click();
  await expect(pageB.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');

  const [signed] = await Promise.all([pageB.waitForEvent('download'), pageB.getByTestId('download-signed').click()]);
  expect(signed.suggestedFilename()).toBe('two-party-signed.pdf');
  const audit = await auditOf(await readFile(await signed.path()));
  expect(audit.passes?.map((pass) => [pass.signerId, pass.signer.name, pass.fieldIds])).toEqual([
    ['a', 'Signer One', ['sigA']],
    ['b', 'Signer Two', ['sigB']],
  ]);
  expect(auditField(audit, 'sigA').signerId).toBe('a');
  expect(seenB.problems).toEqual([]);
  await deviceB.close();
});

test('with the relay, the choices ask for the next signer\'s email before "Email it"', async ({ page }) => {
  const seen = watch(page);
  await page.route('**/relay/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ turnstileSiteKey: '' }) }),
  );
  await page.goto('/');
  await page.getByTestId('open-packet-input').setInputFiles({
    name: 'synthetic.signpacket.json',
    mimeType: 'application/json',
    buffer: Buffer.from(packet(), 'utf8'),
  });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await page.getByTestId('guide-next').click();
  await typeInDialog(page, 'Signer One');
  await page.getByTestId('consent').check();
  await page.getByTestId('guide-send').click();
  const address = page.getByLabel("Signer Two's email");
  await expect(address).toBeFocused();
  const emailIt = page.getByTestId('email-handoff');
  await expect(emailIt).toHaveText('Email it');
  await expect(emailIt).toBeDisabled();
  await address.fill('not an address');
  await expect(emailIt).toBeDisabled();
  await address.fill('b@example.com');
  await expect(emailIt).toBeEnabled();
  // "Email it" sits directly under the address; the choices are one stack of equal size.
  const field = await address.boundingBox();
  const boxes = await page.getByTestId('turn-choices').getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  expect(boxes).toHaveLength(3);
  expect(boxes[0]!.y).toBeGreaterThan(field!.y + field!.height);
  for (const box of boxes) {
    expect(box.width).toBeCloseTo(boxes[0]!.width, 0);
    expect(box.x).toBeCloseTo(boxes[0]!.x, 0);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await emailIt.click();
  await expect(page.getByTestId('email-to-given')).toHaveText('To b@example.com');
  await expect(page.getByTestId('email-password')).toBeVisible();
  expect(seen.problems).toEqual([]);
});
