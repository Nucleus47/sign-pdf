import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Locator, type Page, type Request } from '@playwright/test';
import { verifySignedPdf } from '@sign-pdf/core';
import type { AuditRecord } from '@sign-pdf/spec';

/** Synthetic signer used across the suite. */
export const SIGNER = 'Test Signer';

export interface Watch {
  requests: Request[];
  problems: string[];
}

/** Record every request, CSP violation and uncaught error on the page. */
export function watch(page: Page): Watch {
  const seen: Watch = { requests: [], problems: [] };
  // A blocked action that the page's code catches is not logged; the violation event still fires.
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page.on('request', (request) => seen.requests.push(request));
  page.on('pageerror', (error) => seen.problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    seen.problems.push(`console: ${message.text()}`);
  });
  return seen;
}

/** Every request went to the page's own origin, and none to /api. */
export function expectOnlyOwnStaticAssets(seen: Watch, baseURL: string): void {
  const origin = new URL(baseURL).origin;
  const foreign = seen.requests
    .map((request) => request.url())
    .filter((url) => !url.startsWith('blob:') && !url.startsWith('data:'))
    .filter((url) => new URL(url).origin !== origin);
  expect(foreign, 'requests to another origin').toEqual([]);
  const api = seen.requests.map((request) => new URL(request.url()).pathname).filter((path) => path.startsWith('/api'));
  expect(api, 'requests to /api without a session').toEqual([]);
}

/** Choose sample-nda.pdf in the start page's PDF picker. */
export async function chooseSamplePdf(page: Page): Promise<void> {
  await page.getByTestId('open-pdf-input').setInputFiles({ name: 'sample-nda.pdf', mimeType: 'application/pdf', buffer: await readSample() });
}

/** Choose sample-nda.pdf from the start page's PDF picker while it has focus, with the keyboard. */
export async function chooseSamplePdfByKeyboard(page: Page): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Space')]);
  await chooser.setFiles({ name: 'sample-nda.pdf', mimeType: 'application/pdf', buffer: await readSample() });
}

/**
 * Open the sample NDA with its form fields (sample-nda.pdf) in the prepare
 * view, with no fields placed. The start page's "Try the sample agreement"
 * opens the demo instead (demo.spec.ts).
 */
export async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
  await chooseSamplePdf(page);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('pdf-page-3')).toBeVisible();
}

export interface FormField {
  type: 'text' | 'date' | 'checkbox' | 'signature' | 'initials';
  label: string;
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** Add a field through the form only: no pointer on the page. */
export async function addFieldByForm(page: Page, field: FormField): Promise<void> {
  const count = Number(await page.getByTestId('field-count').textContent());
  await page.getByTestId('add-type').selectOption(field.type);
  await page.getByTestId('add-label').fill(field.label);
  await page.getByTestId('add-mode-coords').check();
  await page.getByTestId('add-page').fill(String(field.page));
  await page.getByTestId('add-x').fill(String(field.x));
  await page.getByTestId('add-y').fill(String(field.y));
  if (field.width !== undefined) await page.getByTestId('add-width').fill(String(field.width));
  if (field.height !== undefined) await page.getByTestId('add-height').fill(String(field.height));
  await page.getByTestId('add-field').click();
  await expect(page.getByTestId('field-count')).toHaveText(String(count + 1));
}

/** The sample's signature block for Party A is on page 3. */
export async function addSampleFields(page: Page): Promise<void> {
  await addFieldByForm(page, { type: 'signature', label: 'Party A signature', page: 3, x: 190, y: 92, width: 160, height: 30 });
  await addFieldByForm(page, { type: 'text', label: 'Party A name', page: 3, x: 140, y: 142, width: 170, height: 16 });
  await addFieldByForm(page, { type: 'date', label: 'Date signed', page: 3, x: 392, y: 100, width: 110, height: 16 });
}

/** Draw two strokes on the signature pad with the mouse. */
export async function drawSignature(page: Page): Promise<void> {
  const pad = page.getByTestId('signature-pad');
  await expect(pad).toBeVisible();
  const box = await pad.boundingBox();
  if (!box) throw new Error('signature pad has no box');
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  const strokes = [
    [at(0.15, 0.6), at(0.3, 0.3), at(0.4, 0.7), at(0.55, 0.35), at(0.7, 0.65)],
    [at(0.2, 0.75), at(0.8, 0.72)],
  ];
  for (const stroke of strokes) {
    const [first, ...rest] = stroke;
    if (!first) continue;
    await page.mouse.move(first[0], first[1]);
    await page.mouse.down();
    for (const point of rest) await page.mouse.move(point[0], point[1], { steps: 6 });
    await page.mouse.up();
  }
}

/** Download the packet from the prepare view and return its text. */
export async function downloadPacketText(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-packet').click(),
  ]);
  expect(download.suggestedFilename()).toBe('sample-nda.signpacket.json');
  return readFile(await download.path(), 'utf8');
}

// ---------------------------------------------------------------------------
// Geometry, exports and synthetic files shared by the pointer, placement and signature specs.

/** US Letter width in points: the sample and every PDF built in these tests use it. */
export const PAGE_WIDTH_PT = 612;

export interface RectPt {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** CSS pixels per PDF point for a page as it is shown now. */
export async function pageScale(page: Page, pageNumber: number): Promise<number> {
  const box = await page.getByTestId(`pdf-page-${pageNumber}`).boundingBox();
  if (!box) throw new Error(`page ${pageNumber} has no box`);
  return box.width / PAGE_WIDTH_PT;
}

/** A field box's rectangle in points, as the app reports it. */
export async function fieldRect(page: Page, id: string): Promise<RectPt> {
  const box = page.getByTestId(`field-box-${id}`);
  await expect(box).toBeVisible();
  return box.evaluate((element) => {
    const data = (element as HTMLElement).dataset;
    const section = element.closest('[data-page]') as HTMLElement;
    return {
      page: Number(section.dataset.page),
      x: Number(data.x),
      y: Number(data.y),
      width: Number(data.width),
      height: Number(data.height),
    };
  });
}

/** Press on an element's centre, move the pointer by a distance in points, release. */
export async function dragByPoints(page: Page, target: Locator, dxPt: number, dyPt: number, scale: number): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('drag target has no box');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dxPt * scale, startY + dyPt * scale, { steps: 8 });
  await page.mouse.up();
}

export interface ExportedRequest {
  document: { name: string; sha256: string };
  fields: Array<{ id: string; type: string; placement: Record<string, unknown> }>;
}

/** The request JSON as the prepare view exports it. */
export async function downloadRequestJson(page: Page): Promise<ExportedRequest> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-request').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.signrequest\.json$/);
  return JSON.parse(await readFile(await download.path(), 'utf8')) as ExportedRequest;
}

/**
 * Open the sign view's full list: every field, the name and the confirmation
 * at once, as before guided signing. Specs about other features use it; the
 * guided walk has its own spec.
 */
export async function showAllFields(page: Page): Promise<void> {
  const toggle = page.getByTestId('show-all-fields');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** Name, consent, sign, and return the signed PDF's bytes. */
export async function signAndDownload(page: Page): Promise<Buffer> {
  await page.getByTestId('signer-name').fill(SIGNER);
  await page.getByTestId('consent').check();
  await expect(page.getByTestId('sign-button')).toBeEnabled();
  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-signed').click(),
  ]);
  return readFile(await download.path());
}

export interface TextBox {
  x: number;
  y: number;
  right: number;
  bottom: number;
}

/** Where a run of text sits on a shown page, in points, read from the pdf.js text layer. */
export async function textPosition(page: Page, pageNumber: number, text: string): Promise<TextBox> {
  const span = page.getByTestId(`pdf-page-${pageNumber}`).locator('.textLayer span', { hasText: text }).first();
  await expect(span).toBeAttached();
  return span.evaluate((element, widthPt) => {
    const pageBox = (element.closest('[data-page]') as HTMLElement).getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const scale = pageBox.width / widthPt;
    return {
      x: (box.left - pageBox.left) / scale,
      y: (box.top - pageBox.top) / scale,
      right: (box.right - pageBox.left) / scale,
      bottom: (box.bottom - pageBox.top) / scale,
    };
  }, PAGE_WIDTH_PT);
}

/** Share of dark pixels inside a rectangle of a rendered page: tells drawn ink from blank paper. */
export async function inkFraction(page: Page, rect: RectPt): Promise<number> {
  const section = page.getByTestId(`pdf-page-${rect.page}`);
  await section.scrollIntoViewIfNeeded();
  const canvas = section.locator('.pdf-canvas canvas');
  await expect(canvas).toBeVisible();
  return canvas.evaluate(
    (element, area) => {
      const source = element as HTMLCanvasElement;
      const context = source.getContext('2d');
      if (!context) throw new Error('no 2d context');
      const perPt = source.width / area.pageWidth;
      const width = Math.max(1, Math.floor(area.width * perPt));
      const height = Math.max(1, Math.floor(area.height * perPt));
      const { data } = context.getImageData(Math.floor(area.x * perPt), Math.floor(area.y * perPt), width, height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        const light = ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3;
        if ((data[i + 3] ?? 0) > 128 && light < 128) dark += 1;
      }
      return dark / (width * height);
    },
    { ...rect, pageWidth: PAGE_WIDTH_PT },
  );
}

/** A synthetic "scanned signature": dark strokes on white paper, as PNG bytes. */
export function makeSignaturePng(width = 240, height = 90): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const wave = height / 2 + Math.sin(x / 9) * (height / 3);
      const ink = x > 12 && x < width - 12 && (Math.abs(y - wave) < 3 || Math.abs(y - (height - 14)) < 1.5);
      if (!ink) continue;
      const at = y * stride + 1 + x * 4;
      raw[at] = 20;
      raw[at + 1] = 30;
      raw[at + 2] = 60;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits per channel, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface DroppedFile {
  name: string;
  type: string;
  /** File content, base64. */
  base64?: string;
  /** Instead of content: a file of this many zero bytes, made in the page. */
  zeroBytes?: number;
}

/** Drag files over an element and drop them, as a person dragging from the desktop would. */
export async function dropFiles(page: Page, testId: string, files: DroppedFile[]): Promise<void> {
  const dataTransfer = await page.evaluateHandle((items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      const parts: BlobPart[] = [];
      if (item.zeroBytes !== undefined) {
        const megabyte = new Uint8Array(1024 * 1024);
        const whole = Math.floor(item.zeroBytes / megabyte.length);
        for (let i = 0; i < whole; i += 1) parts.push(megabyte);
        parts.push(new Uint8Array(item.zeroBytes - whole * megabyte.length));
      } else {
        parts.push(Uint8Array.from(atob(item.base64 ?? ''), (char) => char.charCodeAt(0)));
      }
      transfer.items.add(new File(parts, item.name, { type: item.type }));
    }
    return transfer;
  }, files);
  const zone = page.getByTestId(testId);
  await zone.dispatchEvent('dragenter', { dataTransfer });
  await expect(zone).toHaveAttribute('data-over', 'true');
  await zone.dispatchEvent('dragover', { dataTransfer });
  await zone.dispatchEvent('drop', { dataTransfer });
  await expect(zone).not.toHaveAttribute('data-over', 'true');
  await dataTransfer.dispose();
}

export function readSample(): Promise<Buffer> {
  return readFile(new URL('../public/sample-nda.pdf', import.meta.url));
}

/** Read the audit record out of a signed PDF with the core, outside the browser. */
export async function auditOf(signed: Buffer): Promise<AuditRecord> {
  const result = await verifySignedPdf(new Uint8Array(signed));
  expect(result.problems).toEqual([]);
  if (!result.audit) throw new Error('the signed PDF has no audit record');
  return result.audit;
}

export function auditField(audit: AuditRecord, id: string): AuditRecord['fields'][number] {
  const field = audit.fields.find((item) => item.id === id);
  if (!field) throw new Error(`no audit entry for ${id}`);
  return field;
}
