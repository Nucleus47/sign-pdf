/**
 * Send it again (issue #98): the first signer emails the hand-off, reloads,
 * opens "Documents you sent", downloads the hand-off PDF built from the copy
 * this device kept, and emails it again under a new link. The relay is faked
 * with page.route; e2e/relay-worker.spec.ts runs against a real Worker.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { readHandoffPdf } from '@sign-pdf/core';
import { watch } from './helpers.ts';
import { buildPacketText, buildPdf, rectAt } from './pdf.ts';

const packet = () =>
  buildPacketText(buildPdf([{ texts: [{ text: 'Synthetic two-party form', x: 72, y: 720, size: 16 }] }]), {
    name: 'two-party.pdf',
    signers: [
      { id: 'a', name: 'Signer One' },
      { id: 'b', name: 'Signer Two' },
    ],
    fields: [
      { id: 'sigA', type: 'signature', label: 'First signature', assignee: 'human', signerId: 'a', placement: rectAt(1, 72, 200, 200, 44) },
      { id: 'sigB', type: 'signature', label: 'Second signature', assignee: 'human', signerId: 'b', placement: rectAt(1, 72, 300, 200, 44) },
    ],
  });

const EXPIRES = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

/** A fake relay: every upload and send is recorded; `failSend` answers the next sends with 502. */
async function fakeRelay(page: Page) {
  const relay = { uploads: [] as string[], sends: [] as string[], failSend: false };
  await page.route('**/relay/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/relay/config') return json(200, { turnstileSiteKey: '' });
    if (path === '/relay/login') return json(200, { ok: true });
    if (path === '/relay/login/verify') return json(200, { session: 'synthetic.session', expiresAt: EXPIRES() });
    const doc = /^\/relay\/docs\/([A-Za-z0-9_-]{22})(\/send)?$/.exec(path);
    if (doc?.[1] && request.method() === 'PUT') {
      relay.uploads.push(doc[1]);
      return json(200, { id: doc[1], expiresAt: EXPIRES() });
    }
    if (doc?.[1] && doc[2] && request.method() === 'POST') {
      relay.sends.push(doc[1]);
      return relay.failSend ? json(502, { error: 'mail failed', code: 'email-failed' }) : json(200, { ok: true });
    }
    return json(404, { error: 'not found', code: 'not-found' });
  });
  return relay;
}

async function signFirstTurnAndEmail(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('open-packet-input').setInputFiles({
    name: 'synthetic.signpacket.json',
    mimeType: 'application/json',
    buffer: Buffer.from(packet(), 'utf8'),
  });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await page.getByTestId('guide-next').click();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill('Signer One');
  await page.getByTestId('signature-apply').click();
  await page.getByTestId('consent').check();
  // The address goes in the end-of-turn block; the dialog shows it and does not ask again.
  await page.getByTestId('next-email').fill('signer.two@example.com');
  await page.getByTestId('email-handoff').click();
  await expect(page.getByTestId('email-to-given')).toHaveText('To signer.two@example.com');
  await page.getByTestId('email-continue').click();
  await page.getByTestId('email-own').fill('signer.one@example.com');
  await page.getByTestId('email-send-code').click();
  await page.getByTestId('email-code-input').fill('123456');
  await page.getByTestId('email-verify').click();
}

test('after a reload, the first signer downloads the hand-off PDF again and emails it again under a new link', async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const seen = watch(page);
  const relay = await fakeRelay(page);

  await signFirstTurnAndEmail(page);
  await expect(page.getByTestId('handoff-sent')).toContainText('Sent to Signer Two');
  await expect(page.getByTestId('handoff-not-arrived')).toHaveText('Did it not arrive? Send it again or download the PDF.');
  expect(relay.sends).toHaveLength(1);

  // The hand-off was in memory only before; now this device keeps it.
  await page.reload();
  // The browser keeps the ciphertext, never the packet.
  const stored = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('sign-pdf');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const read = open.result.transaction('sent-handoffs').objectStore('sent-handoffs').getAll();
          read.onsuccess = () => resolve(JSON.stringify(read.result.map((entry: { blob: Uint8Array }) => Array.from(entry.blob).map((b) => String.fromCharCode(b)).join(''))) + JSON.stringify(read.result.map((entry: object) => Object.keys(entry))));
        };
      }),
  );
  expect(stored).not.toContain('sign-pdf-packet');
  expect(stored).not.toContain('"packet"');
  await page.getByTestId('go-sent-list').click();
  const item = page.getByTestId('sent-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('two-party.pdf');
  await expect(item).toContainText('signer.two@example.com');
  await expect(item.getByTestId('sent-item-download')).toHaveText('Download the PDF for Signer Two');

  const [download] = await Promise.all([page.waitForEvent('download'), item.getByTestId('sent-item-download').click()]);
  expect(download.suggestedFilename()).toBe('two-party-signed-1-of-2-handoff.pdf');
  const contents = await readHandoffPdf(new Uint8Array(await readFile(await download.path())));
  expect(contents?.passes.map((pass) => pass.signerId)).toEqual(['a']);

  // Email it again: a new id. The sign-in of this tab is still live.
  await item.getByTestId('sent-item-email').click();
  await expect(page.getByTestId('email-to')).toHaveValue('signer.two@example.com');
  await page.getByTestId('email-continue').click();
  await expect(page.getByTestId('sent-list-status')).toContainText('Sent to Signer Two (signer.two@example.com)');
  expect(relay.sends).toHaveLength(2);
  expect(relay.sends[1]).not.toBe(relay.sends[0]);
  await expect(page.getByTestId('sent-item')).toHaveCount(1);
  expect(seen.problems).toEqual([]);
  await context.close();
});

test('a send that failed after the upload is kept, and goes out from "Documents you sent" after a reload', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const relay = await fakeRelay(page);
  relay.failSend = true;

  await signFirstTurnAndEmail(page);
  await expect(page.getByTestId('email-error')).toBeVisible();
  await expect(page.getByTestId('email-kept')).toContainText('A copy stays on this device.');

  await page.reload();
  relay.failSend = false;
  await page.getByTestId('go-sent-list').click();
  const item = page.getByTestId('sent-item');
  await expect(item.getByTestId('sent-item-sent')).toHaveText('Not sent');
  await item.getByTestId('sent-item-email').click();
  await page.getByTestId('email-to').fill('signer.two@example.com');
  await page.getByTestId('email-continue').click();
  await expect(page.getByTestId('sent-list-status')).toContainText('Sent to Signer Two');
  await expect(page.getByTestId('sent-item')).toHaveCount(1);
  await expect(page.getByTestId('sent-item-sent')).not.toHaveText('Not sent');
  await context.close();
});
