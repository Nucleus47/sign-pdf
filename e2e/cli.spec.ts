/**
 * The hand-off with both real halves: the built command-line tool serves the
 * built web app, a browser opens the link from stderr, and a synthetic person
 * signs. Nothing is mocked.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { expect, test } from '@playwright/test';
import { requestSha256 } from '@sign-pdf/core';
import {
  makeFixture,
  nonceOf,
  openSignView,
  reportCspViolations,
  runCli,
  signAsTestSigner,
  SIGNER,
  slowNetwork,
  startRequest,
  watch,
  type Fixture,
  type RunningCli,
} from './helpers.ts';

let fixture: Fixture;
let cli: RunningCli | undefined;

test.beforeEach(async () => {
  fixture = await makeFixture();
});

test.afterEach(async () => {
  await cli?.stop();
  cli = undefined;
  await fixture.cleanup();
});

/** True when nothing listens on the port any more. */
function isClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

/** stdout of a `--json` command is exactly one JSON object. */
function oneObject(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  expect(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)).toBe(true);
  return parsed as Record<string, unknown>;
}

test('request: the human signs in the browser and the command returns the signed PDF', async ({ page }) => {
  await reportCspViolations(page);
  const problems = watch(page);
  cli = startRequest(fixture);
  const link = await cli.link;
  const nonce = nonceOf(link);

  // The session token is never in the address, in storage or in a cookie.
  let token = '';
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/api/session') return;
    void response.json().then((body: { token?: string }) => (token = body.token ?? ''));
  });

  await openSignView(page, link);
  await expect(page.getByTestId('document-name')).toContainText('fixture.pdf');
  await signAsTestSigner(page);
  const pageSha = (await page.getByTestId('signed-sha256').textContent())?.trim();

  expect(token).not.toBe('');
  expect(token).not.toBe(nonce);
  const kept = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie, location.href]));
  expect(kept).not.toContain(token);
  expect(kept).not.toContain(nonce);

  const exit = await cli.done;
  expect(exit.code, exit.stderr).toBe(0);
  const result = oneObject(exit.stdout);
  expect(result).toMatchObject({ ok: true, status: 'signed', integrity: 'unverified', path: fixture.outPath, sha256: pageSha });
  // The agent reads stdout: neither the nonce nor the token is there. The token is on neither stream.
  expect(exit.stdout).not.toContain(nonce);
  expect(exit.stdout).not.toContain(token);
  expect(exit.stderr).not.toContain(token);

  const info = await stat(fixture.outPath);
  expect(info.isFile()).toBe(true);
  if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
  expect((await readFile(fixture.outPath)).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  const verify = await runCli(['verify', fixture.outPath, '--json']);
  expect(verify.code, verify.stderr).toBe(0);
  const record = oneObject(verify.stdout);
  expect(record).toMatchObject({ ok: true, hasAuditRecord: true, integrity: 'unverified', sha256: pageSha, problems: [] });
  // `verify` prints the record itself; `request` printed its summary. Both name this document and this request.
  const expectedRequestSha = await requestSha256(fixture.request);
  expect(record['audit']).toMatchObject({
    signer: { name: SIGNER },
    document: { name: 'fixture.pdf', originalSha256: fixture.request.document.sha256 },
    requestSha256: expectedRequestSha,
  });
  expect(result['audit']).toMatchObject({
    signerName: SIGNER,
    documentName: 'fixture.pdf',
    originalSha256: fixture.request.document.sha256,
    requestSha256: expectedRequestSha,
    signedFieldIds: ['sig'],
  });
  expect(result['problems']).toEqual([]);

  // The server is gone. The page still shows the signed document: it needs nothing more from the server.
  expect(await isClosed(Number(new URL(link).port))).toBe(true);
  await expect(page.locator('[data-view="signed"] canvas').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  // The served pages ran clean under the server's own security headers.
  expect(problems).toEqual([]);
});

test('request: the link works once; a second opener is told so and the first page still signs', async ({ page, browser }) => {
  await reportCspViolations(page);
  const problems = watch(page);
  cli = startRequest(fixture);
  const link = await cli.link;
  await openSignView(page, link);
  await slowNetwork(page);

  // Another program (its own browser profile) opens the same link.
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await reportCspViolations(other);
    const otherProblems = watch(other);
    await other.goto(link);
    const problem = other.getByTestId('link-problem');
    await expect(problem).toHaveAttribute('data-problem', 'already-opened');
    await expect(problem).toContainText(
      'This signing link was already opened, in another tab or by another program. Ask the app that sent it to start again; do not sign if you did not open it yourself.',
    );
    await expect(problem).toContainText('run the command again to get a new link');
    await expect(problem.getByRole('button')).toHaveCount(0);
    expect(other.url()).not.toContain('session=');
    // The refused exchange is the only thing that went wrong on that page.
    expect(otherProblems.filter((line) => !line.includes('401'))).toEqual([]);
    expect(otherProblems).toContain('status 401: /api/session');
  } finally {
    await otherContext.close();
  }

  await signAsTestSigner(page);
  const exit = await cli.done;
  expect(exit.code, exit.stderr).toBe(0);
  expect(oneObject(exit.stdout)).toMatchObject({ ok: true, status: 'signed', integrity: 'unverified' });
  expect((await stat(fixture.outPath)).isFile()).toBe(true);
  // On the slow network the server closed before the page could load anything again:
  // the signed document is drawn from what the browser kept.
  await expect(page.locator('[data-view="signed"] canvas').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(problems).toEqual([]);
});

test('request: a reload says the link works once and how to get a new one', async ({ page }) => {
  await reportCspViolations(page);
  cli = startRequest(fixture);
  const link = await cli.link;
  await openSignView(page, link);
  await page.reload();
  const problem = page.getByTestId('link-problem');
  await expect(problem).toContainText('This page was reloaded, and a signing link works only once.');
  await expect(problem).toContainText('run the command again to get a new link');
  // Nothing in the tab can resume the session: the token was in memory only.
  expect(await page.evaluate(() => JSON.stringify(window.sessionStorage))).not.toContain(nonceOf(link));
  // A second reload is an ordinary start page.
  await page.reload();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-view', 'home');
});

test('request: the first of two signers downloads a hand-off PDF and the command exits with code 4', async ({ page }) => {
  await reportCspViolations(page);
  const problems = watch(page);
  const { signer: _oneSigner, ...base } = fixture.request;
  const request = {
    ...base,
    signers: [
      { id: 'a', name: 'Signer One' },
      { id: 'b', name: 'Signer Two' },
    ],
    fields: [
      { id: 'name', type: 'text', assignee: 'agent', value: 'Ada Example', placement: { kind: 'rect', page: 1, x: 72, y: 300, width: 200, height: 20 } },
      { id: 'sigA', type: 'signature', assignee: 'human', signerId: 'a', placement: { kind: 'anchor', text: 'Signature:', align: 'right', dx: 6, width: 180, height: 36 } },
      { id: 'sigB', type: 'signature', assignee: 'human', signerId: 'b', placement: { kind: 'rect', page: 1, x: 340, y: 620, width: 180, height: 36 } },
    ],
  };
  await writeFile(fixture.requestPath, JSON.stringify(request));
  cli = startRequest(fixture);
  // The local app has no relay: it answers /relay/config with its page (#92).
  const config = page.waitForResponse((response) => response.url().endsWith('/relay/config'));
  await openSignView(page, await cli.link);

  await page.getByTestId('guide-next').click();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill('Signer One');
  await page.getByTestId('signature-apply').click();
  await page.getByTestId('consent').check();
  await config;
  // So no email is offered, and the download is the primary choice.
  await expect(page.getByTestId('sign-button')).toHaveClass(/primary/);
  await expect(page.getByTestId('next-email')).toHaveCount(0);
  await expect(page.getByTestId('email-handoff')).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('sign-button').click()]);
  expect(download.suggestedFilename()).toBe('fixture-signed-1-of-2-handoff.pdf');
  // The page tells the command, which ends as handed off and writes no file.
  await expect(page.getByTestId('handoff-told')).toBeVisible();

  const exit = await cli.done;
  expect(exit.code, exit.stderr).toBe(4);
  expect(oneObject(exit.stdout)).toMatchObject({ status: 'handed_off', signed: ['a'], pending: ['b'] });
  await expect(stat(fixture.outPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(problems).toEqual([]);
});
