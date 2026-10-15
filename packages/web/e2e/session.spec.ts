import { expect, test, type Page, type Route } from '@playwright/test';
import { addSampleFields, downloadPacketText, expectOnlyOwnStaticAssets, openSample, showAllFields, SIGNER, watch } from './helpers.ts';

const TOKEN = 'e2e-session-token';
const NONCE = 'e2e-session-nonce';

/** Play the local app's nonce exchange: the token is given out for the right nonce. */
async function routeSession(page: Page): Promise<{ bodies: string[]; headers: Record<string, string>[] }> {
  const seen = { bodies: [] as string[], headers: [] as Record<string, string>[] };
  await page.route('**/api/session', async (route: Route) => {
    seen.bodies.push(route.request().postData() ?? '');
    seen.headers.push(route.request().headers());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: TOKEN }) });
  });
  return seen;
}

function errorBody(code: string): string {
  return JSON.stringify({ error: 'A sentence from the local app.', code });
}

/** Build a real packet with the app itself, to play the local CLI's part. */
async function makePacket(page: Page): Promise<string> {
  await openSample(page);
  await addSampleFields(page);
  const text = await downloadPacketText(page);
  // The local app opens the session link in a fresh tab; leave the app first.
  await page.goto('about:blank');
  return text;
}

async function typeSignatureAndFinish(page: Page): Promise<void> {
  await showAllFields(page);
  await page.getByTestId('value-text1').fill(SIGNER);
  await page.getByTestId('capture-signature1').click();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill(SIGNER);
  await page.getByTestId('signature-apply').click();
  await page.getByTestId('signer-name').fill(SIGNER);
  await page.getByTestId('consent').check();
}

test('without a session link the app never calls /api', async ({ page, baseURL }) => {
  const seen = watch(page);
  await openSample(page);
  await addSampleFields(page);
  await page.getByTestId('continue-to-sign').click();
  await typeSignatureAndFinish(page);
  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'signed');
  await expect(page.getByTestId('sent-status')).toHaveCount(0);
  await expect(page.getByTestId('decline')).toHaveCount(0);
  expectOnlyOwnStaticAssets(seen, baseURL ?? '');
});

test('loopback session: packet in, signed PDF back', async ({ page }) => {
  const packetText = await makePacket(page);

  const exchange = await routeSession(page);
  const packetRequests: Record<string, string>[] = [];
  let signed: { headers: Record<string, string>; body: Buffer | null } | undefined;
  await page.route('**/api/packet', async (route: Route) => {
    packetRequests.push(route.request().headers());
    await route.fulfill({ status: 200, contentType: 'application/json', body: packetText });
  });
  await page.route('**/api/signed', async (route: Route) => {
    signed = { headers: route.request().headers(), body: route.request().postDataBuffer() };
    await route.fulfill({ status: 204 });
  });

  await page.goto(`/#session=${NONCE}`);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  // The nonce is exchanged once, as JSON, without an Authorization header.
  expect(exchange.bodies).toEqual([JSON.stringify({ nonce: NONCE })]);
  expect(exchange.headers[0]?.['content-type']).toBe('application/json');
  expect(exchange.headers[0]?.authorization).toBeUndefined();
  expect(packetRequests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  // The nonce is gone from the address bar, and the token never gets there or into storage.
  expect(page.url()).not.toContain(NONCE);
  expect(page.url()).not.toContain(TOKEN);
  expect(page.url()).not.toContain('session=');
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
  expect(stored).not.toContain(TOKEN);
  expect(stored).not.toContain(NONCE);

  await typeSignatureAndFinish(page);
  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('sent-status')).toHaveText('Sent back to the requesting app. You can close this tab.');
  await expect(page.getByTestId('download-signed')).toBeVisible();

  const sha = (await page.getByTestId('signed-sha256').textContent())?.trim();
  expect(signed?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  expect(signed?.headers['content-type']).toBe('application/pdf');
  expect(signed?.headers['x-sign-pdf-sha256']).toBe(sha);
  expect(signed?.body?.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('loopback session: a failed hand-back shows the error and keeps the download', async ({ page }) => {
  const packetText = await makePacket(page);
  await page.route('**/api/packet', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: packetText }));
  await routeSession(page);
  let attempts = 0;
  await page.route('**/api/signed', async (route) => {
    attempts += 1;
    if (attempts === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: errorBody('save-failed') });
    else if (attempts === 2) await route.fulfill({ status: 422, contentType: 'application/json', body: errorBody('wrong-request') });
    else await route.fulfill({ status: 204 });
  });

  await page.goto(`/#session=${NONCE}`);
  await typeSignatureAndFinish(page);
  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('sent-error')).toHaveAttribute('data-code', 'save-failed');
  await expect(page.getByTestId('sent-error')).toContainText('accepted the signed PDF but could not save it');
  await expect(page.getByTestId('download-signed')).toBeVisible();

  await page.getByTestId('send-again').click();
  await expect(page.getByTestId('sent-error')).toHaveAttribute('data-code', 'wrong-request');
  await expect(page.getByTestId('sent-error')).toContainText('waiting for a different signature request');
  await expect(page.getByTestId('download-signed')).toBeVisible();

  await page.getByTestId('send-again').click();
  await expect(page.getByTestId('sent-status')).toHaveText('Sent back to the requesting app. You can close this tab.');
  expect(attempts).toBe(3);
});

test('a session link that was already opened says so and offers nothing else', async ({ page }) => {
  const apiPaths: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) apiPaths.push(path);
  });
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: errorBody('session-already-opened') }),
  );
  await page.goto(`/#session=${NONCE}`);
  const problem = page.getByTestId('link-problem');
  await expect(problem).toHaveAttribute('data-problem', 'already-opened');
  await expect(problem).toContainText(
    'This signing link was already opened, in another tab or by another program. Ask the app that sent it to start again; do not sign if you did not open it yourself.',
  );
  await expect(problem).toContainText('If you reloaded this page or the command has ended, run the command again to get a new link.');
  await expect(problem.getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
  expect(page.url()).not.toContain(NONCE);
  expect(apiPaths).toEqual(['/api/session']);
});

for (const [code, status] of [['invalid-nonce', 401], ['session-locked', 429], ['session-finished', 409]] as const) {
  test(`a session link answered with ${code} is no longer valid`, async ({ page }) => {
    await page.route('**/api/session', (route) =>
      route.fulfill({ status, contentType: 'application/json', body: errorBody(code) }),
    );
    await page.goto(`/#session=${NONCE}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This signing link is no longer valid');
    await expect(page.getByTestId('link-problem')).toHaveAttribute('data-problem', 'not-valid');
    await expect(page.getByTestId('link-problem')).toContainText('start a new signature request');
    await page.getByTestId('link-problem-home').click();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-view', 'home');
  });
}

test('a local app that cannot be reached gets a retry, and the retry opens the document', async ({ page }) => {
  const packetText = await makePacket(page);
  let exchanges = 0;
  await page.route('**/api/session', async (route) => {
    exchanges += 1;
    if (exchanges === 1) await route.abort('connectionrefused');
    else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: TOKEN }) });
  });
  await page.route('**/api/packet', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: packetText }));

  await page.goto(`/#session=${NONCE}`);
  await expect(page.getByTestId('connect-problem')).toContainText('The requesting app did not answer.');
  await page.getByTestId('connect-retry').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  expect(exchanges).toBe(2);
});

test('a session link no local app answers is reported as not valid', async ({ page }) => {
  // The preview server is a static site: it has no /api/session route.
  await page.goto(`/#session=${NONCE}`);
  await expect(page.getByTestId('link-problem')).toHaveAttribute('data-problem', 'not-valid');
  await expect(page.getByTestId('link-problem')).toContainText('No app is waiting for a signature at this address.');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'empty');
  expect(page.url()).not.toContain(NONCE);
});
