import { expect, test, type Page } from '@playwright/test';
import { expectOnlyOwnStaticAssets, openSample, watch } from './helpers.ts';

/** The browser agent API (issue #45): window.signPdf, the paste box, the #request= link and WebMCP. */

interface Candidate {
  number: number;
  kind: string;
  suggested: { placement: Record<string, unknown>; type?: string };
}

type Result = Record<string, unknown>;

/** Call one window.signPdf tool in the page. */
function call(page: Page, name: string, input?: unknown): Promise<Result> {
  return page.evaluate(
    async ([tool, arg]) => {
      const api = (window as unknown as { signPdf?: Record<string, (input?: unknown) => Promise<Result>> }).signPdf;
      if (!api) throw new Error('window.signPdf is not defined');
      return api[tool as string]!(arg);
    },
    [name, input] as const,
  );
}

/** A request from the sample's candidates 8, 9, 11 and 12: both signatures and both dates on page 3. No `document`. */
async function sampleRequest(page: Page): Promise<Result> {
  const found = await call(page, 'find_candidates');
  const candidates = (found['untrusted_document_content'] as { candidates: Candidate[] }).candidates;
  expect(candidates).toHaveLength(13);
  const pick = (number: number) => candidates.find((candidate) => candidate.number === number)!;
  expect(pick(8).suggested.placement).toMatchObject({ kind: 'anchor', page: 3 });
  expect(pick(11).suggested.placement).toMatchObject({ kind: 'anchor', page: 3 });
  expect(pick(9).suggested.placement).toEqual({ kind: 'acroField', name: 'Date' });
  expect(pick(12).suggested.placement).toEqual({ kind: 'acroField', name: 'Date_2' });
  return {
    fields: [
      { id: 'sig_a', type: 'signature', label: 'Signature', assignee: 'human', required: true, placement: pick(8).suggested.placement },
      { id: 'date_a', type: 'date', label: 'Date', assignee: 'human', required: true, placement: pick(9).suggested.placement },
      { id: 'sig_b', type: 'signature', label: 'Signature', assignee: 'human', required: true, placement: pick(11).suggested.placement },
      { id: 'date_b', type: 'date', label: 'Date', assignee: 'human', required: true, placement: pick(12).suggested.placement },
    ],
  };
}

test('window.signPdf finds, checks, previews and applies a request, and is gone in the sign view', async ({ page, baseURL }) => {
  const seen = watch(page);
  await openSample(page);

  const request = await sampleRequest(page);
  const validation = await call(page, 'validate_request', { request });
  expect(validation['ok'], JSON.stringify(validation['errors'])).toBe(true);

  const preview = await call(page, 'render_preview', { request, pages: [3] });
  const images = preview['images'] as Array<{ page: number; width: number; png_base64: string }>;
  expect(images).toHaveLength(1);
  const png = Buffer.from(images[0]!.png_base64, 'base64');
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.readUInt32BE(16)).toBe(images[0]!.width);

  const applied = await call(page, 'apply_request', { request });
  expect(applied).toMatchObject({ ok: true, applied: true, field_count: 4 });
  await expect(page.getByTestId('field-count')).toHaveText('4');

  const state = await call(page, 'get_state');
  expect(state).toMatchObject({ view: 'prepare', field_count: 4 });

  // Bad input comes back as an error object; nothing throws.
  const bad = await call(page, 'validate_request', {});
  expect(bad['error']).toMatchObject({ code: 'usage' });

  await page.getByTestId('continue-to-sign').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  expect(await page.evaluate(() => 'signPdf' in window)).toBe(false);

  expectOnlyOwnStaticAssets(seen, baseURL!);
  expect(seen.problems).toEqual([]);
});

test('a #request= link puts its fields on the page once the sample opens', async ({ page }) => {
  await openSample(page);
  const request = await sampleRequest(page);
  await page.goto('about:blank');

  await page.goto(`/#request=${encodeURIComponent(JSON.stringify(request))}`);
  // The request is taken out of the address bar at once.
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await expect(page.getByText('An agent’s request is waiting')).toBeVisible();
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('field-count')).toHaveText('4');
  await expect(page.getByTestId('request-result')).toContainText('4 fields');
});

test('a #request= link for another PDF stays waiting after the mismatch until the person dismisses it', async ({ page }) => {
  const request = { document: { name: 'other.pdf', sha256: 'a'.repeat(64) }, fields: [{ id: 'sig', type: 'signature', label: 'Signature', assignee: 'human', placement: { kind: 'rect', page: 1, x: 72, y: 72, width: 150, height: 30 } }] };
  await page.goto(`/#request=${encodeURIComponent(JSON.stringify(request))}`);
  const waiting = page.getByText('An agent’s request is waiting');
  await expect(waiting).toBeVisible();

  const openSampleAgain = async () => {
    await page.getByTestId('load-sample').click();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
    await expect(page.getByTestId('request-result')).toContainText('This request was written for a different PDF');
  };
  const goHome = async () => {
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
  };

  await openSampleAgain();
  await goHome();
  // The wrong PDF was opened: the request still waits for the right one.
  await openSampleAgain();
  await page.getByTestId('dismiss-request').click();
  await expect(page.getByTestId('request-result')).toHaveCount(0);
  await goHome();
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'preparing');
  await expect(page.getByTestId('request-result')).toHaveCount(0);
});

test('on a phone the paste box scrolls into view below the sticky page view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page);
  const summary = page.getByTestId('request-paste').locator('summary');
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await page.getByTestId('request-json').fill('{ not json');
  await page.getByTestId('apply-request').click();
  const result = page.getByTestId('request-result');
  await expect(result).toBeVisible();
  for (const target of [summary, result]) {
    await target.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    const viewer = await page.locator('.viewer').boundingBox();
    const box = await target.boundingBox();
    expect(box!.y, 'below the page view').toBeGreaterThanOrEqual(viewer!.y + viewer!.height);
  }
});

test('the paste box applies a request and refuses one written for a different PDF', async ({ page }) => {
  await openSample(page);
  const request = await sampleRequest(page);

  const box = page.getByTestId('request-paste');
  await box.locator('summary').click();
  await page.getByTestId('request-json').fill(JSON.stringify({ ...request, document: { name: 'other.pdf', sha256: 'a'.repeat(64) } }));
  await page.getByTestId('apply-request').click();
  await expect(page.getByTestId('request-result')).toContainText('This request was written for a different PDF');
  await expect(page.getByTestId('field-count')).toHaveText('0');

  await page.getByTestId('request-json').fill('{ not json');
  await page.getByTestId('apply-request').click();
  await expect(page.getByTestId('request-result')).toContainText('This is not valid JSON');

  await page.getByTestId('request-json').fill(JSON.stringify(request));
  await page.getByTestId('apply-request').click();
  await expect(page.getByTestId('request-result')).toContainText('The request is on the page: 4 fields');
  await expect(page.getByTestId('field-count')).toHaveText('4');
});

test('WebMCP: the tools are registered in the prepare view and removed in the sign view', async ({ page }) => {
  await page.addInitScript(() => {
    const live = new Map<string, { execute(input: unknown): Promise<unknown>; annotations?: Record<string, boolean> }>();
    const record = window as unknown as { __webmcp: typeof live };
    record.__webmcp = live;
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool(tool: { name: string; execute(input: unknown): Promise<unknown> }, options?: { signal?: AbortSignal }) {
          live.set(tool.name, tool);
          options?.signal?.addEventListener('abort', () => live.delete(tool.name));
          return Promise.resolve();
        },
      },
    });
  });
  await openSample(page);

  const names = () => page.evaluate(() => [...(window as unknown as { __webmcp: Map<string, unknown> }).__webmcp.keys()].sort());
  await expect.poll(names).toEqual(
    ['apply_request', 'download_packet', 'download_request', 'find_candidates', 'get_request_schema', 'get_state', 'inspect_pdf', 'render_preview', 'validate_request'],
  );

  const result = await page.evaluate(async () => {
    const tool = (window as unknown as { __webmcp: Map<string, { execute(input: unknown): Promise<unknown>; annotations?: Record<string, boolean> }> }).__webmcp.get('find_candidates')!;
    // Chrome before 155 passes the input as a JSON string.
    return { annotations: tool.annotations, out: (await tool.execute('{}')) as { structuredContent: Record<string, unknown> } };
  });
  expect(result.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
  expect(result.out.structuredContent['candidate_count']).toBe(13);

  await call(page, 'apply_request', { request: await sampleRequest(page) });
  await expect(page.getByTestId('field-count')).toHaveText('4');
  await page.getByTestId('continue-to-sign').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await expect.poll(names).toEqual([]);
});
