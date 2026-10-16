import { expect, test, type Page } from '@playwright/test';
import { addFieldByForm, showAllFields, SIGNER, watch } from './helpers.ts';
import { buildPacketText, buildPdf, rectAt } from './pdf.ts';

const RLO = '‮';

async function openPacket(page: Page, packetText: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
  await page.getByTestId('open-packet-input').setInputFiles({
    name: 'synthetic.signpacket.json',
    mimeType: 'application/json',
    buffer: Buffer.from(packetText, 'utf8'),
  });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await showAllFields(page);
  await expect(page.getByTestId('sign-button')).toBeVisible();
}

async function typeSignature(page: Page, fieldId: string): Promise<void> {
  await page.getByTestId(`capture-${fieldId}`).click();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill(SIGNER);
  await page.getByTestId('signature-apply').click();
  await expect(page.getByTestId(`signature-preview-${fieldId}`)).toBeVisible();
}

test('a request cannot pre-satisfy fields assigned to the human', async ({ page }) => {
  const seen = watch(page);
  const pdf = buildPdf([{ texts: [{ text: 'Synthetic agreement', x: 72, y: 720, size: 16 }] }]);
  const packet = buildPacketText(pdf, {
    fields: [
      { id: 'company', type: 'text', label: 'Company name', assignee: 'agent', value: 'Example Company Ltd', placement: rectAt(1, 72, 120, 200, 18) },
      { id: 'role', type: 'text', label: 'Your job title', assignee: 'human', value: 'Director', placement: rectAt(1, 72, 160, 200, 18) },
      { id: 'start', type: 'date', label: 'Start date', assignee: 'human', value: '2026-03-04', placement: rectAt(1, 72, 200, 110, 18) },
      { id: 'agree', type: 'checkbox', label: 'I have authority to sign', assignee: 'human', value: true, placement: rectAt(1, 72, 240, 14, 14) },
      { id: 'sig', type: 'signature', label: 'Signature', assignee: 'human', placement: rectAt(1, 72, 300, 200, 44) },
    ],
  });
  await openPacket(page, packet);

  // The agent-assigned value starts filled and is not counted. The suggestions are shown, marked, and counted.
  await expect(page.getByTestId('progress-text')).toHaveText('0 of 6 required items done');
  await expect(page.getByTestId('prefilled-company')).toBeVisible();
  await expect(page.getByTestId('prefilled-role')).toBeVisible();
  await expect(page.getByTestId('prefilled-start')).toBeVisible();
  await expect(page.getByTestId('value-role')).toHaveValue('Director');
  await expect(page.getByTestId('value-agree')).not.toBeChecked();
  await expect(page.getByTestId('suggested-agree')).toContainText('The preparer suggested ticking this');
  await expect(page.getByTestId('field-box-agree')).not.toContainText('✓');

  // Everything else done: the document still cannot be signed.
  await typeSignature(page, 'sig');
  await page.getByTestId('signer-name').fill(SIGNER);
  await page.getByTestId('consent').check();
  await expect(page.getByTestId('progress-text')).toHaveText('3 of 6 required items done');
  await expect(page.getByTestId('sign-button')).toBeDisabled();
  await expect(page.getByTestId('sign-explanation')).toContainText('Your job title, Start date, I have authority to sign');

  await page.getByTestId('keep-role').click();
  await expect(page.getByTestId('kept-role')).toBeVisible();
  await page.getByTestId('value-start').fill('2026-03-05');
  await expect(page.getByTestId('changed-start')).toBeVisible();
  await expect(page.getByTestId('sign-button')).toBeDisabled();
  await page.getByTestId('value-agree').check();
  await expect(page.getByTestId('field-box-agree')).toContainText('✓');
  await expect(page.getByTestId('progress-text')).toHaveText('6 of 6 required items done');

  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');
  await expect(page.getByTestId('audit-human-kept')).toContainText('Your job title: Director');
  await expect(page.getByTestId('audit-human-kept')).toContainText('I have authority to sign: ticked');
  await expect(page.getByTestId('audit-human-changed')).toContainText('Start date: 2026-03-05');
  await expect(page.getByTestId('audit-agent-filled')).toContainText('Company name: Example Company Ltd');
  await expect(page.getByTestId('audit-agent-filled')).not.toContainText('Your job title');
  await expect(page.getByTestId('pdf-page-1').locator('.textLayer')).toContainText('Director');
  expect(seen.problems).toEqual([]);
});

test('an unticked suggested checkbox is not ticked in the signed PDF', async ({ page }) => {
  const pdf = buildPdf([{ texts: [{ text: 'Synthetic agreement', x: 72, y: 720, size: 16 }] }]);
  const packet = buildPacketText(pdf, {
    fields: [
      { id: 'news', type: 'checkbox', label: 'Send me updates', assignee: 'human', required: false, value: true, placement: rectAt(1, 72, 240, 14, 14) },
      { id: 'sig', type: 'signature', label: 'Signature', assignee: 'human', placement: rectAt(1, 72, 300, 200, 44) },
    ],
  });
  await openPacket(page, packet);
  await expect(page.getByTestId('value-news')).not.toBeChecked();
  await typeSignature(page, 'sig');
  await page.getByTestId('signer-name').fill(SIGNER);
  await page.getByTestId('consent').check();
  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');
  await expect(page.getByTestId('audit-human-changed')).toContainText('Send me updates: not ticked');
  await expect(page.getByTestId('audit-human-kept')).toHaveCount(0);
});

test('direction-override characters in untrusted text are removed and isolated', async ({ page }) => {
  const seen = watch(page);
  const pdf = buildPdf([{ texts: [{ text: 'Synthetic agreement', x: 72, y: 720, size: 16 }] }]);
  const packet = buildPacketText(pdf, {
    // Unfiltered, this name is displayed as "invoiceexe.pdf".
    name: `invoice${RLO}fdp.exe`,
    title: `${RLO}eltiT`,
    note: `${RLO}Please sign today. ⁦Thank you.⁩`,
    fields: [{ id: 'sig', type: 'signature', label: `${RLO}erutangiS`, assignee: 'human', placement: rectAt(1, 72, 300, 200, 44) }],
  });
  await openPacket(page, packet);

  const controls = /[‪-‮⁦-⁩‎‏؜]/;
  const shown = {
    note: page.getByTestId('preparer-text'),
    title: page.getByTestId('preparer-title'),
    name: page.getByTestId('document-name'),
    label: page.getByTestId('review-row-sig').locator('.review-label > span').first(),
  };
  await expect(shown.note).toHaveText('Please sign today. Thank you.');
  await expect(shown.title).toHaveText('eltiT');
  await expect(shown.name).toHaveText('invoicefdp.exe');
  await expect(shown.label).toHaveText('erutangiS');
  for (const locator of Object.values(shown)) {
    await expect(locator).toHaveCSS('unicode-bidi', 'isolate');
  }
  expect(await page.getByTestId('review-list').textContent()).not.toMatch(controls);
  expect(await page.getByTestId('field-box-sig').getAttribute('aria-label')).not.toMatch(controls);

  // The note reads left to right: its first word is drawn at the left edge of its box.
  const edges = await shown.note.evaluate((element) => {
    const range = document.createRange();
    const text = element.firstChild as Text;
    range.setStart(text, 0);
    range.setEnd(text, 6);
    return { word: range.getBoundingClientRect().left, box: element.getBoundingClientRect().left };
  });
  expect(Math.abs(edges.word - edges.box)).toBeLessThan(2);

  await typeSignature(page, 'sig');
  await page.getByTestId('signer-name').fill(SIGNER);
  await page.getByTestId('consent').check();
  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');
  const original = page.getByTestId('audit-document-name');
  await expect(original).toHaveText('invoicefdp.exe');
  await expect(original).toHaveCSS('unicode-bidi', 'isolate');
  expect(await page.getByTestId('audit-summary').textContent()).not.toMatch(controls);
  await expect(page.getByTestId('download-signed')).toContainText('Download the signed PDF');
  await expect(page.getByTestId('download-signed').locator('.download-name')).toHaveText('invoicefdp.exe-signed.pdf');
  expect(seen.problems).toEqual([]);
});

test('a 100-page PDF keeps a bounded number of page canvases while scrolling', async ({ page }) => {
  test.setTimeout(120_000);
  const seen = watch(page);
  const pages = Array.from({ length: 100 }, (_unused, index) => ({
    texts: [{ text: `Synthetic page ${index + 1}`, x: 72, y: 700, size: 18 }],
  }));
  await page.goto('/');
  await page.getByTestId('open-pdf-input').setInputFiles({
    name: 'hundred-pages.pdf',
    mimeType: 'application/pdf',
    buffer: buildPdf(pages),
  });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('pdf-page-100')).toBeAttached();
  await expect(page.getByTestId('pdf-page-1')).toHaveAttribute('data-rendered', 'true');

  // A field on a page that has no canvas is still placed correctly.
  await addFieldByForm(page, { type: 'text', label: 'Far away', page: 90, x: 100, y: 200, width: 150, height: 20 });
  const farBox = () =>
    page.getByTestId('pdf-page-90').evaluate((pageElement) => {
      const box = pageElement.querySelector('[data-field-box]');
      if (!box) throw new Error('no field box on page 90');
      const outer = pageElement.getBoundingClientRect();
      const inner = box.getBoundingClientRect();
      const scale = outer.width / 612;
      return {
        x: (inner.left - outer.left) / scale,
        y: (inner.top - outer.top) / scale,
        width: inner.width / scale,
        canvases: pageElement.querySelectorAll('canvas').length,
      };
    });
  const before = await farBox();
  expect(before.canvases).toBe(0);
  expect(before.x).toBeCloseTo(100, 0);
  expect(before.y).toBeCloseTo(200, 0);
  expect(before.width).toBeCloseTo(150, 0);

  const scroller = page.getByTestId('viewer-scroll');
  const measure = () =>
    scroller.evaluate((element) => {
      const canvases = [...element.querySelectorAll('canvas')];
      return {
        count: canvases.length,
        pixels: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
        step: element.clientHeight,
        height: element.scrollHeight,
      };
    });
  const start = await measure();
  let maxCount = start.count;
  let maxPixels = start.pixels;
  // The layout must not depend on which canvases exist.
  const steps = 60;
  for (let index = 1; index <= steps; index += 1) {
    await scroller.evaluate((element, top) => element.scrollTo(0, top), (start.max * index) / steps);
    await page.waitForTimeout(60);
    const now = await measure();
    maxCount = Math.max(maxCount, now.count);
    maxPixels = Math.max(maxPixels, now.pixels);
    expect(now.height).toBe(start.height);
  }
  await expect(page.getByTestId('pdf-page-100')).toHaveAttribute('data-rendered', 'true');
  await expect(page.getByTestId('pdf-page-1').locator('canvas')).toHaveCount(0);
  await expect.poll(async () => (await measure()).count).toBeLessThanOrEqual(6);
  expect(maxCount).toBeGreaterThan(0);
  expect(maxCount).toBeLessThanOrEqual(8);
  // Far below the 100 full-size backing stores the viewer used to keep.
  expect(maxPixels).toBeLessThanOrEqual(8 * 16_000_000);

  // A page that comes back is drawn again, and its text never left the DOM.
  await scroller.evaluate((element) => element.scrollTo(0, 0));
  await expect(page.getByTestId('pdf-page-1')).toHaveAttribute('data-rendered', 'true');
  await expect(page.getByTestId('pdf-page-1').locator('canvas')).toHaveCount(1);
  await expect(page.getByTestId('pdf-page-100').locator('canvas')).toHaveCount(0);
  await expect(page.getByTestId('pdf-page-100').locator('.textLayer')).toContainText('Synthetic page 100');
  await expect(page.getByTestId('pdf-page-57').locator('.textLayer')).toContainText('Synthetic page 57');
  const after = await farBox();
  expect(after.x).toBeCloseTo(100, 0);
  expect(after.y).toBeCloseTo(200, 0);
  expect(seen.problems).toEqual([]);
});

test('the text layer of a rotated page sits where the text is drawn', async ({ page }) => {
  const seen = watch(page);
  const rotations = [90, 270, 180, 0] as const;
  const pdf = buildPdf(
    rotations.map((rotate) => ({
      width: 300,
      height: 400,
      rotate,
      texts: [{ text: 'ROTATED', x: 60, y: 250, size: 28 }],
    })),
  );
  await page.goto('/');
  await page.getByTestId('open-pdf-input').setInputFiles({ name: 'rotated.pdf', mimeType: 'application/pdf', buffer: pdf });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');

  for (const [index, rotate] of rotations.entries()) {
    const pageBox = page.getByTestId(`pdf-page-${index + 1}`);
    await pageBox.scrollIntoViewIfNeeded();
    await expect(pageBox).toHaveAttribute('data-rendered', 'true');
    await expect(pageBox.locator('.textLayer span', { hasText: 'ROTATED' })).toBeAttached();
    const found = await pageBox.evaluate((element) => {
      const canvas = element.querySelector('canvas');
      const span = [...element.querySelectorAll('.textLayer span')].find((item) => item.textContent === 'ROTATED');
      const layer = element.querySelector('.textLayer');
      const context = canvas?.getContext('2d');
      if (!canvas || !span || !layer || !context) throw new Error('page is not rendered');
      // Where the word is drawn: the bounding box of the dark pixels.
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const at = (y * width + x) * 4;
          if ((data[at] ?? 255) + (data[at + 1] ?? 255) + (data[at + 2] ?? 255) < 384 && (data[at + 3] ?? 0) > 128) {
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
      }
      const outer = element.getBoundingClientRect();
      const css = outer.width / canvas.width;
      const box = span.getBoundingClientRect();
      const layerBox = layer.getBoundingClientRect();
      return {
        ink: { left: left * css, top: top * css, right: (right + 1) * css, bottom: (bottom + 1) * css },
        span: { left: box.left - outer.left, top: box.top - outer.top, right: box.right - outer.left, bottom: box.bottom - outer.top },
        layer: { left: layerBox.left - outer.left, top: layerBox.top - outer.top, width: layerBox.width, height: layerBox.height },
        page: { width: outer.width, height: outer.height },
      };
    });
    const label = `/Rotate ${rotate}`;
    // The layer covers the page as displayed.
    expect(Math.abs(found.layer.left), label).toBeLessThan(1.5);
    expect(Math.abs(found.layer.top), label).toBeLessThan(1.5);
    expect(Math.abs(found.layer.width - found.page.width), label).toBeLessThan(1.5);
    expect(Math.abs(found.layer.height - found.page.height), label).toBeLessThan(1.5);
    // The word in the DOM covers the drawn word (a text box is a little larger than its ink).
    const slack = 4;
    expect(found.span.left, label).toBeLessThanOrEqual(found.ink.left + slack);
    expect(found.span.top, label).toBeLessThanOrEqual(found.ink.top + slack);
    expect(found.span.right, label).toBeGreaterThanOrEqual(found.ink.right - slack);
    expect(found.span.bottom, label).toBeGreaterThanOrEqual(found.ink.bottom - slack);
    const inkLong = Math.max(found.ink.right - found.ink.left, found.ink.bottom - found.ink.top);
    const spanLong = Math.max(found.span.right - found.span.left, found.span.bottom - found.span.top);
    expect(Math.abs(spanLong - inkLong), label).toBeLessThan(inkLong * 0.1);
    const centre = (box: { left: number; top: number; right: number; bottom: number }) => ({
      x: (box.left + box.right) / 2,
      y: (box.top + box.bottom) / 2,
    });
    expect(Math.abs(centre(found.span).x - centre(found.ink).x), label).toBeLessThan(10);
    expect(Math.abs(centre(found.span).y - centre(found.ink).y), label).toBeLessThan(10);
  }
  expect(seen.problems).toEqual([]);
});

/** Every visible real button smaller than `min` CSS pixels in either direction. */
async function smallButtons(page: Page, min: number): Promise<string[]> {
  return page.evaluate((limit) => {
    const found: string[] = [];
    for (const button of document.querySelectorAll('button')) {
      const box = button.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.width < limit - 0.5 || box.height < limit - 0.5) {
        const name = button.getAttribute('data-testid') ?? button.textContent ?? '';
        found.push(`${name.trim()} ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
    return found;
  }, min);
}

const reviewPacket = () =>
  buildPacketText(
    buildPdf([
      {
        texts: [
          { text: 'The line of text above the signature box.', x: 72, y: 520, size: 12 },
          { text: 'Signature: ________________', x: 72, y: 500, size: 12 },
        ],
      },
    ]),
    {
      title: 'Synthetic agreement',
      note: 'Please review the suggested values.',
      fields: [
        { id: 'company', type: 'text', label: 'Company name', assignee: 'agent', value: 'Example Company Ltd', placement: rectAt(1, 72, 120, 200, 18) },
        { id: 'role', type: 'text', label: 'Your job title', assignee: 'human', value: 'Director', placement: rectAt(1, 72, 160, 200, 18) },
        { id: 'agree', type: 'checkbox', label: 'I have authority to sign', assignee: 'human', value: true, placement: rectAt(1, 72, 200, 14, 14) },
        { id: 'sig', type: 'signature', label: 'Signature', assignee: 'human', placement: rectAt(1, 130, 276, 180, 28) },
      ],
    },
  );

for (const size of [
  { name: 'phone', width: 375, height: 812, min: 44 },
  { name: 'desktop', width: 1280, height: 800, min: 24 },
]) {
  test(`${size.name}: buttons are at least ${size.min}px and the "Sign here" tag stays inside its box`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });

    await page.goto('/');
    await expect(page.getByTestId('load-sample')).toBeVisible();
    expect(await smallButtons(page, size.min), 'home').toEqual([]);

    await page.getByTestId('load-sample').click();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
    await expect(page.getByTestId('field-count')).toHaveText('6');
    await addFieldByForm(page, { type: 'text', label: 'Party A name', page: 3, x: 140, y: 142, width: 170, height: 16 });
    expect(await smallButtons(page, size.min), 'prepare').toEqual([]);

    await page.goto('about:blank');
    await openPacket(page, reviewPacket());
    await expect(page.getByTestId('keep-role')).toBeVisible();
    expect(await smallButtons(page, size.min), 'sign').toEqual([]);

    // The tag does not reach outside the signature box, so it cannot cover the document's text.
    const tag = await page.getByTestId('field-box-sig').evaluate((box) => {
      const flag = box.querySelector('.field-flag');
      if (!flag) throw new Error('no flag');
      const outer = box.getBoundingClientRect();
      const inner = flag.getBoundingClientRect();
      return {
        text: flag.textContent,
        inside:
          inner.left >= outer.left - 0.5 &&
          inner.top >= outer.top - 0.5 &&
          inner.right <= outer.right + 0.5 &&
          inner.bottom <= outer.bottom + 0.5,
        height: inner.height,
      };
    });
    expect(tag.text).toBe('Sign here');
    expect(tag.inside).toBe(true);
    expect(tag.height).toBeGreaterThan(6);

    await page.getByTestId('capture-sig').click();
    await expect(page.getByTestId('signature-dialog')).toBeVisible();
    expect(await smallButtons(page, size.min), 'signature dialog').toEqual([]);
  });
}
