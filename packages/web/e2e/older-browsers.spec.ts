import { expect, test, type Page } from '@playwright/test';
import { buildPacketText, buildPdf } from './pdf.ts';

/**
 * Removes features that the browser target (Safari 16.4, docs/browser-support.md)
 * lacks and that pdf.js calls. Runs as a string in the page and in the pdf.js worker,
 * so it must not refer to anything outside itself.
 */
function removeNewFeatures(): void {
  const remove = (owner: object | undefined, ...keys: PropertyKey[]) => {
    for (const key of keys) if (owner) delete (owner as Record<PropertyKey, unknown>)[key];
  };
  remove(Map.prototype, 'getOrInsertComputed', 'getOrInsert');
  remove(WeakMap.prototype, 'getOrInsertComputed', 'getOrInsert');
  remove(Promise, 'withResolvers', 'try');
  remove(Set.prototype, 'intersection', 'union', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom');
  remove(Uint8Array, 'fromBase64', 'fromHex');
  remove(Uint8Array.prototype, 'toBase64', 'toHex', 'setFromBase64', 'setFromHex');
  remove(ArrayBuffer.prototype, 'transferToFixedLength');
  remove(Math, 'sumPrecise');
  remove(JSON, 'rawJSON', 'isRawJSON');
  remove(globalThis, 'Float16Array');
  // Async iteration of ReadableStream, which pdf.js uses to read page text and to decompress images.
  remove(ReadableStream.prototype, Symbol.asyncIterator, 'values');
  (globalThis as { featuresRemoved?: boolean }).featuresRemoved = true;
}

const removal = `(${removeNewFeatures.toString()})();\n`;

/**
 * The removed features pdf.js needs, as the page or worker has them once pdf.js has
 * loaded: each must be back, installed by our polyfills or by core-js inside pdf.js.
 * pdf.js handles some failures silently (the worker falls back to slower decoding),
 * so this checks the features themselves, not only that a PDF opens.
 */
async function featureReport(): Promise<Record<string, boolean>> {
  const proto = (value: object) => value as Record<PropertyKey, unknown>;
  let iterated = false;
  try {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.close();
      },
    });
    for await (const chunk of stream as unknown as AsyncIterable<number>) iterated = chunk === 1;
  } catch {
    iterated = false;
  }
  return {
    featuresRemoved: (globalThis as { featuresRemoved?: boolean }).featuresRemoved === true,
    readableStreamIteration: iterated,
    promiseWithResolvers: typeof proto(Promise).withResolvers === 'function',
    promiseTry: typeof proto(Promise).try === 'function',
    mapGetOrInsertComputed: typeof proto(Map.prototype).getOrInsertComputed === 'function',
    setIntersection: typeof proto(Set.prototype).intersection === 'function',
    uint8ArrayFromBase64: typeof proto(Uint8Array).fromBase64 === 'function',
    mathSumPrecise: typeof proto(Math).sumPrecise === 'function',
    arrayBufferTransferToFixedLength: typeof proto(ArrayBuffer.prototype).transferToFixedLength === 'function',
  };
}

const allPresent = {
  featuresRemoved: true,
  readableStreamIteration: true,
  promiseWithResolvers: true,
  promiseTry: true,
  mapGetOrInsertComputed: true,
  setIntersection: true,
  uint8ArrayFromBase64: true,
  mathSumPrecise: true,
  arrayBufferTransferToFixedLength: true,
};

/** Removes the features in the page and, by rewriting its script, in the pdf.js worker. */
async function removeNewFeaturesEverywhere(page: Page): Promise<void> {
  await page.addInitScript(removal);
  // addInitScript does not reach workers. The worker is a module with no imports
  // (Vite bundles it into one file), so code put before it runs first.
  await page.route(/\/assets\/pdf\.worker-[\w-]+\.js$/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    // Two files match: the worker itself, and a small module in the page that only holds its URL.
    // The page module is left alone: running the removal there again would undo the page's polyfills.
    if (!body.includes('WorkerMessageHandler')) {
      await route.fulfill({ response });
      return;
    }
    if (/^\s*import[\s{*'"]/m.test(body)) throw new Error('The pdf.js worker imports another module; prepending would run after it.');
    await route.fulfill({ response, body: removal + body });
  });
}

/** The feature report of each live pdf.js worker; pdf.js may have closed earlier ones. */
async function workerReports(page: Page): Promise<Record<string, boolean>[]> {
  const workers = page.workers().filter((worker) => /\/assets\/pdf\.worker-/.test(worker.url()));
  return Promise.all(workers.map((worker) => worker.evaluate(featureReport)));
}

// Shipping Safari on iPhone lacks some features pdf.js calls.
// Remove them in the page and in the worker: the app must still open and read a PDF.
test('opens a PDF in a browser without the features Safari 16.4 lacks', async ({ page }) => {
  await removeNewFeaturesEverywhere(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  expect(await page.evaluate(() => 'getOrInsertComputed' in Map.prototype)).toBe(false);
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-view', 'prepare');
  await expect(page.locator('[data-page] canvas').first()).toBeVisible();
  // Reading the page text is what failed on an older iPhone: the text layer and candidates use it.
  await expect(page.locator('.textLayer span').first()).toBeAttached();
  expect(errors).toEqual([]);
  expect(await page.evaluate(featureReport)).toEqual(allPresent);
  const reports = await workerReports(page);
  expect(reports.length).toBeGreaterThan(0);
  for (const report of reports) expect(report).toEqual(allPresent);
});

test('resolves an anchored field, which reads the page text, without those features', async ({ page }) => {
  await removeNewFeaturesEverywhere(page);
  const pdf = buildPdf([{ texts: [{ text: 'Signature:', x: 72, y: 600, size: 12 }] }]);
  const packet = buildPacketText(pdf, {
    fields: [
      { id: 'sig', type: 'signature', label: 'Signature', assignee: 'human', placement: { kind: 'anchor', text: 'Signature:', align: 'right', dx: 6, width: 180, height: 36 } },
    ],
  });
  await page.goto('/');
  await page.getByTestId('open-packet-input').setInputFiles({ name: 'synthetic.signpacket.json', mimeType: 'application/json', buffer: Buffer.from(packet, 'utf8') });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await expect(page.getByTestId('field-box-sig')).toBeVisible();
  const reports = await workerReports(page);
  expect(reports.length).toBeGreaterThan(0);
  for (const report of reports) expect(report).toEqual(allPresent);
});
