import { expect, test, type Page } from '@playwright/test';
import { watch } from './helpers.ts';
import { buildPacketText, buildPdf, rectAt } from './pdf.ts';

const packet = () =>
  buildPacketText(
    buildPdf([
      {
        texts: [
          { text: 'Synthetic agreement for guided signing', x: 72, y: 720, size: 16 },
          { text: 'Name: ____________________', x: 72, y: 640, size: 11 },
          { text: 'Signature: ____________________', x: 72, y: 560, size: 11 },
          { text: 'Initials: ______', x: 72, y: 480, size: 11 },
          { text: 'Signature again: ____________________', x: 72, y: 400, size: 11 },
        ],
      },
    ]),
    {
      fields: [
        { id: 'ref', type: 'text', label: 'Reference', assignee: 'agent', value: 'REF-0001', placement: rectAt(1, 360, 60, 160, 18) },
        { id: 'name', type: 'text', label: 'Your name', assignee: 'human', placement: rectAt(1, 110, 136, 160, 16) },
        { id: 'sig1', type: 'signature', label: 'Signature', assignee: 'human', placement: rectAt(1, 130, 206, 180, 28) },
        { id: 'ini1', type: 'initials', label: 'Initials', assignee: 'human', placement: rectAt(1, 120, 292, 60, 20) },
        { id: 'sig2', type: 'signature', label: 'Signature again', assignee: 'human', placement: rectAt(1, 170, 366, 180, 28) },
        { id: 'when', type: 'date', label: 'Date', assignee: 'human', placement: rectAt(1, 360, 420, 100, 16) },
      ],
    },
  );

async function openPacket(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('open-packet-input').setInputFiles({
    name: 'synthetic.signpacket.json',
    mimeType: 'application/json',
    buffer: Buffer.from(packet(), 'utf8'),
  });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
}

async function typeInDialog(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId('signature-dialog')).toBeVisible();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill(text);
  await page.getByTestId('signature-apply').click();
}

/** Nothing on the page scrolls sideways. */
async function expectNoSideways(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.view);
}

/** The element is not covered by anything, the floating bar included. */
async function expectUncovered(page: Page, testId: string): Promise<void> {
  const free = await page.getByTestId(testId).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return top !== null && (element === top || element.contains(top) || top.contains(element) || top === element.closest('label'));
  });
  expect(free, `${testId} is covered`).toBe(true);
}

for (const size of [
  { name: 'phone', width: 390, height: 844 },
  { name: 'small phone', width: 360, height: 740 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1366, height: 900 },
]) {
  test(`${size.name}: the floating button walks every field, one tap per signature after the first`, async ({ page }) => {
    const seen = watch(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await openPacket(page);
    const next = page.getByTestId('guide-next');
    const narrow = size.width < 900;

    // The button sits low on the screen, where a thumb reaches, and inside it.
    const bar = await next.boundingBox();
    expect(bar).not.toBeNull();
    if (bar) {
      expect(bar.y + bar.height).toBeLessThanOrEqual(size.height);
      if (narrow) expect(bar.y).toBeGreaterThan(size.height * 0.75);
    }
    // The document gets most of the screen on a narrow one.
    const viewer = await page.getByTestId('viewer-scroll').boundingBox();
    if (narrow && viewer) expect(viewer.height).toBeGreaterThan(size.height * 0.38);
    await expectNoSideways(page);

    await expect(page.getByTestId('guide-step-title')).toHaveText('Check the prefilled values');
    const zoomBefore = Number.parseInt((await page.getByTestId('zoom-value').textContent()) ?? '0', 10);
    await next.click();

    // The name: its box is selected and in view, its input focused, and on a phone the page zooms in.
    await expect(page.getByTestId('guide-position')).toHaveText('Field 1 of 4');
    await expect(page.getByTestId('field-box-name')).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('field-box-name')).toBeInViewport();
    await expect(page.getByTestId('value-name')).toBeFocused();
    if (size.width < 720) {
      await expect
        .poll(async () => Number.parseInt((await page.getByTestId('zoom-value').textContent()) ?? '0', 10))
        .toBeGreaterThan(zoomBefore);
    }
    await page.getByTestId('value-name').fill('Test Signer');
    await expect(page.getByTestId('field-done-name')).toBeVisible();
    await expectUncovered(page, 'value-name');
    await next.click();

    // The first signature opens capture by itself.
    await typeInDialog(page, 'Test Signer');
    // Initials are their own kind: the first initials open capture too.
    await expect(page.getByTestId('guide-step-title')).toHaveText('Initials');
    await expect(next).toHaveText('Initial here');
    await typeInDialog(page, 'TS');
    // A later signature: the saved one, applied with one tap. No dialog opens.
    await expect(page.getByTestId('guide-step-title')).toHaveText('Signature again');
    await expect(page.getByTestId('signature-dialog')).toBeHidden();
    await expect(next).toHaveText('Sign here');
    await expect(page.getByTestId('saved-signature-sig2')).toBeVisible();
    await expect(page.getByTestId('field-done-sig2')).toHaveCount(0);
    // A tap right after the last one is taken as a double tap and does not apply a signature.
    await page.waitForTimeout(450);
    await next.click();
    await expect(page.getByTestId('field-done-sig2')).toBeVisible();
    // The date, filled in with today, is skipped.
    await expect(page.getByTestId('field-done-when')).toBeVisible();

    await expect(page.getByTestId('guide-step-title')).toHaveText('Confirm and sign');
    await page.getByTestId('signer-name').fill('Test Signer');
    await page.getByTestId('consent').check();
    await expectUncovered(page, 'consent');
    await expectNoSideways(page);
    await expect(page.getByTestId('sign-button')).toHaveText('Sign as Test Signer');
    await page.getByTestId('sign-button').click();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');
    await expect(page.getByTestId('download-signed')).toBeInViewport();
    expect(seen.problems).toEqual([]);
  });
}
