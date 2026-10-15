/**
 * The whole relay round trip against a local relay Worker with the dev
 * outbox (see docs/relay.md "Local development"): A emails the document, B opens the
 * link in a fresh browser and signs, the relay emails A a code, and A opens
 * the return link in the browser that sent the email, enters the code and
 * downloads the signed PDF, which the relay then deletes. A third case
 * collects in a fresh browser with the passphrase (issue #105).
 *
 * Skipped unless RELAY_E2E_URL names the Worker, e.g.
 *   RELAY_E2E_URL=http://127.0.0.1:<port> pnpm --filter @sign-pdf/web exec playwright test -c playwright.relay.config.ts
 * RELAY_E2E_SHOTS names a folder for desktop and mobile screenshots.
 *
 * The relay allows 5 sign-ins and 10 uploads per minute per IP: the tests run
 * one after another, and the last one waits a minute before it starts.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { auditOf } from './helpers.ts';
import { buildPacketText, buildPdf, rectAt } from './pdf.ts';

const origin = process.env.RELAY_E2E_URL ?? '';
const shots = process.env.RELAY_E2E_SHOTS ?? '';
test.skip(!origin, 'RELAY_E2E_URL is not set: no relay Worker to test against.');
test.describe.configure({ mode: 'serial' });

// A new address per run: the relay limits sign-in codes per address.
const A_EMAIL = `signer-one-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
const B_EMAIL = 'signer-two@example.test';

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

interface OutboxMessage {
  to: string;
  text: string;
}

async function outbox(): Promise<OutboxMessage[]> {
  const response = await fetch(`${origin}/relay/dev/outbox`);
  return ((await response.json()) as { messages: OutboxMessage[] }).messages;
}

async function sign(page: Page, name: string): Promise<void> {
  await page.getByTestId('guide-next').click();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill(name);
  await page.getByTestId('signature-apply').click();
  await page.getByTestId('consent').check();
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/${name}-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
}

/** A signs and emails B (signing in by code from the outbox). A's browser stays open for the return link. */
async function sendFromA(browser: Browser, password: string | null, from: string): Promise<{ link: string; a: BrowserContext }> {
  const a = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  const page = await a.newPage();
  await page.goto(`${origin}/`);
  await page.getByTestId('open-packet-input').setInputFiles({
    name: 'synthetic.signpacket.json',
    mimeType: 'application/json',
    buffer: Buffer.from(packet(), 'utf8'),
  });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await sign(page, 'Signer One');
  // The next signer's address goes in the block of choices, before "Email it".
  await page.getByTestId('next-email').fill(B_EMAIL);
  await page.getByTestId('email-handoff').click();
  await expect(page.getByTestId('email-to-given')).toContainText(B_EMAIL);
  if (password) await page.getByTestId('email-password').fill(password);
  await page.getByTestId('email-continue').click();
  await page.getByTestId('email-own').fill(from);
  const before = (await outbox()).length;
  await page.getByTestId('email-send-code').click();
  await expect.poll(async () => (await outbox()).length).toBeGreaterThan(before);
  const code = /code is (\d{6})/.exec((await outbox()).at(-1)?.text ?? '')?.[1] ?? '';
  await page.getByTestId('email-code-input').fill(code);
  const sentBefore = (await outbox()).length;
  await page.getByTestId('email-verify').click();
  await expect(page.getByTestId('handoff-sent')).toContainText('Sent to Signer Two');
  const toB = (await outbox()).slice(sentBefore).find((message) => message.to === B_EMAIL);
  await page.close();
  const link = /https?:\/\/\S+#relay=\S+/.exec(toB?.text ?? '')?.[0] ?? '';
  expect(link).toContain('&k=');
  return { link, a };
}

/** B opens the link, signs and sends the signed PDF back; returns A's email. */
async function signAsB(browser: Browser, link: string, to: string, password: string | null): Promise<OutboxMessage> {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  await page.goto(link);
  await expect(page.getByTestId('relay-open')).toContainText('Open the document');
  // The key is out of the address bar, and nothing was asked of the relay.
  expect(page.url()).not.toContain('k=');
  expect(requests.filter((request) => request.includes('/relay/'))).toEqual([]);
  if (password) {
    await shoot(page, 'open-password');
    await page.getByTestId('relay-password').fill('not it');
    await page.getByTestId('relay-open-button').click();
    await expect(page.getByTestId('relay-open-error')).toContainText('Could not open. Check the password.');
    await shoot(page, 'open-error');
    await page.getByTestId('relay-password').fill(password);
  } else {
    await expect(page.getByTestId('relay-password')).toHaveCount(0);
    await shoot(page, 'open-plain');
  }
  await page.getByTestId('relay-open-button').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  expect(requests.filter((request) => request.startsWith('GET /relay/docs/'))).toHaveLength(1);

  const before = (await outbox()).length;
  await sign(page, 'Signer Two');
  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('sent-status')).toContainText('Sent back to Signer One.');
  if (shots) await expect(page.locator('canvas').first()).toBeVisible();
  await shoot(page, 'signed-sent');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-signed').click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(requests.some((request) => request.includes('/api'))).toBe(false);
  await context.close();

  const toA = (await outbox()).slice(before).find((message) => message.to === to);
  expect(toA?.text).toMatch(/Your code: \d{6}/);
  return toA!;
}

/** A opens the return link in the browser that sent the email, enters the code, and downloads. */
async function collectAsA(a: BrowserContext, email: OutboxMessage, password: string | null): Promise<void> {
  const link = /https?:\/\/\S+#relay=[A-Za-z0-9_-]+/.exec(email.text)?.[0] ?? '';
  const code = /Your code: (\d{6})/.exec(email.text)?.[1] ?? '';
  expect(link).not.toContain('k=');
  const id = link.split('#relay=')[1] ?? '';
  const page = await a.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  await page.goto(link);
  await expect(page.getByTestId('relay-collect')).toContainText('Your signed document is ready');
  // Nothing is fetched before the code is submitted.
  expect(requests.filter((request) => request.includes('/relay/'))).toEqual([]);
  await shoot(page, password ? 'collect-password' : 'collect');

  await page.getByTestId('relay-collect-code').fill(code);
  if (password) await page.getByTestId('relay-collect-password').fill(password);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('relay-collect-button').click()]);
  expect(download.suggestedFilename()).toBe('two-party-signed.pdf');
  const audit = await auditOf(await readFile(await download.path()));
  expect(audit.passes?.map((pass) => pass.signer.name)).toEqual(['Signer One', 'Signer Two']);
  await expect(page.getByTestId('relay-collect-done')).toContainText('The copy on the server is deleted.');
  await shoot(page, password ? 'collect-done-password' : 'collect-done');
  // The relay copy is gone, and the kept key with it.
  await expect
    .poll(async () => (await fetch(`${origin}/relay/docs/${id}/final`, { headers: { 'X-Relay-Code': code } })).status)
    .toBe(404);
  expect(await page.evaluate((name) => window.localStorage.getItem(name), `sign-pdf.relay.${id}`)).toBeNull();
  expect(requests.filter((request) => request.includes('/relay/'))).toEqual([
    `GET /relay/docs/${id}/final`,
    `DELETE /relay/docs/${id}`,
  ]);
  await page.close();

  // Another browser has no key: it asks for the passphrase, says what to do without one, and fetches nothing.
  const other = await a.browser()!.newContext({ viewport: { width: 1280, height: 800 } });
  const elsewhere = await other.newPage();
  const otherRequests: string[] = [];
  elsewhere.on('request', (request) => otherRequests.push(new URL(request.url()).pathname));
  await elsewhere.goto(link);
  await expect(elsewhere.getByTestId('relay-collect-password')).toBeVisible();
  await expect(elsewhere.getByTestId('relay-collect-nopass')).toContainText('ask the other signer for the PDF');
  expect(otherRequests.filter((path) => path.startsWith('/relay/'))).toEqual([]);
  await other.close();
}

/** A opens the return link in a fresh browser (no kept key) and collects with the code and the passphrase. */
async function collectElsewhere(browser: Browser, email: OutboxMessage, passphrase: string): Promise<void> {
  const link = /https?:\/\/\S+#relay=[A-Za-z0-9_-]+/.exec(email.text)?.[0] ?? '';
  const code = /Your code: (\d{6})/.exec(email.text)?.[1] ?? '';
  const id = link.split('#relay=')[1] ?? '';
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const requests: string[] = [];
  const sentText: string[] = [];
  page.on('request', (request) => {
    requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    sentText.push(request.url(), JSON.stringify(request.headers()), request.postData() ?? '');
  });
  await page.goto(link);
  await expect(page.getByTestId('relay-collect')).toContainText('the passphrase you set when you sent the document');
  expect(requests.filter((request) => request.includes('/relay/'))).toEqual([]);
  await shoot(page, 'collect-anydevice');

  // A wrong passphrase fails on this device: one GET, no second code attempt.
  await page.getByTestId('relay-collect-code').fill(code);
  await page.getByTestId('relay-collect-password').fill('not the passphrase');
  await page.getByTestId('relay-collect-button').click();
  await expect(page.getByTestId('relay-collect-error')).toContainText('Wrong passphrase.');
  await expect(page.getByTestId('relay-collect-code')).toHaveCount(0);
  await shoot(page, 'collect-anydevice-wrong');

  await page.getByTestId('relay-collect-password').fill(passphrase);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('relay-collect-button').click()]);
  // This browser kept no file name.
  expect(download.suggestedFilename()).toBe('signed.pdf');
  const audit = await auditOf(await readFile(await download.path()));
  expect(audit.passes?.map((pass) => pass.signer.name)).toEqual(['Signer One', 'Signer Two']);
  await expect(page.getByTestId('relay-collect-done')).toContainText('The copy on the server is deleted.');
  expect(requests.filter((request) => request.includes('/relay/'))).toEqual([
    `GET /relay/docs/${id}/final`,
    `DELETE /relay/docs/${id}`,
  ]);
  // The passphrase never left the browser.
  expect(sentText.join('\n')).not.toContain(passphrase);
  await expect
    .poll(async () => (await fetch(`${origin}/relay/docs/${id}/final`, { headers: { 'X-Relay-Code': code } })).status)
    .toBe(404);
  await context.close();
}

/** Without a passphrase, a fresh browser cannot open the signed PDF: it says so after the code, and deletes nothing. */
async function tryElsewhereWithoutPassphrase(browser: Browser, email: OutboxMessage): Promise<void> {
  const link = /https?:\/\/\S+#relay=[A-Za-z0-9_-]+/.exec(email.text)?.[0] ?? '';
  const code = /Your code: (\d{6})/.exec(email.text)?.[1] ?? '';
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(link);
  await page.getByTestId('relay-collect-code').fill(code);
  await page.getByTestId('relay-collect-password').fill('some passphrase');
  await page.getByTestId('relay-collect-button').click();
  await expect(page.getByTestId('relay-collect-nokey')).toContainText('ask the other signer for the PDF');
  await shoot(page, 'collect-nokey');
  await context.close();
}

test('A emails with a password, B signs, A collects the signed PDF with the code', async ({ browser }) => {
  test.setTimeout(180_000);
  const { link, a } = await sendFromA(browser, 'pässword', A_EMAIL);
  expect(link).toContain('&p=1');
  const email = await signAsB(browser, link, A_EMAIL, 'pässword');
  await collectAsA(a, email, 'pässword');
  await a.close();
});

test('the same loop without a password', async ({ browser }) => {
  test.setTimeout(180_000);
  const from = `plain-${A_EMAIL}`;
  const { link, a } = await sendFromA(browser, null, from);
  const email = await signAsB(browser, link, from, null);
  // A fresh browser uses one code attempt and learns there is no wrapped key; the sending browser still collects.
  await tryElsewhereWithoutPassphrase(browser, email);
  await collectAsA(a, email, null);
  await a.close();
});

test('A collects on a fresh browser context with the passphrase', async ({ browser }) => {
  test.setTimeout(180_000);
  const from = `anydevice-${A_EMAIL}`;
  const passphrase = 'correct horse battery';
  const { link, a } = await sendFromA(browser, passphrase, from);
  // A's sending browser is not used again: the key comes back wrapped.
  await a.close();
  const email = await signAsB(browser, link, from, passphrase);
  await collectElsewhere(browser, email, passphrase);
});

test('A emails it again from "Documents you sent" under a new link; the old link still works', async ({ browser }) => {
  test.setTimeout(180_000);
  const from = `again-${A_EMAIL}`;
  // The relay allows 10 uploads per minute per IP, and the three loops above use 9 of them;
  // this test needs 4. Wait for the window to reset.
  await new Promise((resolve) => setTimeout(resolve, 61_000));
  const first = await sendFromA(browser, null, from);
  const oldId = /#relay=([A-Za-z0-9_-]+)/.exec(first.link)?.[1] ?? '';

  // A new tab of the same browser: the copy is kept, the sign-in of the old tab is not.
  const page = await first.a.newPage();
  await page.goto(`${origin}/`);
  await page.getByTestId('go-sent-list').click();
  await expect(page.getByTestId('sent-item')).toHaveCount(1);
  await page.getByTestId('sent-item-email').click();
  await expect(page.getByTestId('email-to')).toHaveValue(B_EMAIL);
  await page.getByTestId('email-continue').click();
  await page.getByTestId('email-own').fill(from);
  const before = (await outbox()).length;
  await page.getByTestId('email-send-code').click();
  await expect.poll(async () => (await outbox()).length).toBeGreaterThan(before);
  const code = /code is (\d{6})/.exec((await outbox()).at(-1)?.text ?? '')?.[1] ?? '';
  await page.getByTestId('email-code-input').fill(code);
  const sentBefore = (await outbox()).length;
  await page.getByTestId('email-verify').click();
  await expect(page.getByTestId('sent-list-status')).toContainText('Sent to Signer Two');
  const toB = (await outbox()).slice(sentBefore).find((message) => message.to === B_EMAIL);
  const link = /https?:\/\/\S+#relay=\S+/.exec(toB?.text ?? '')?.[0] ?? '';
  expect(link).not.toContain(oldId);
  // The old link still works until it expires.
  expect((await fetch(`${origin}/relay/docs/${oldId}`)).status).toBe(200);
  await page.close();

  // B opens the new link. Signing it is left out: it would use more uploads than the limit allows.
  const b = await browser.newContext();
  const pageB = await b.newPage();
  await pageB.goto(link);
  await pageB.getByTestId('relay-open-button').click();
  await expect(pageB.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  await b.close();
  await first.a.close();
});
