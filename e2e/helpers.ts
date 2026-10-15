/**
 * Shared parts of the integration tests: a synthetic document, the real
 * command-line tool as a child process, and the synthetic person who signs
 * in the real web build.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type Request } from '@playwright/test';
import { fixturePdf, requestFor } from '@sign-pdf/cli/test-helpers';
import type { SignRequestInput } from '@sign-pdf/spec';

/** The synthetic person. No real name is used anywhere in these tests. */
export const SIGNER = 'Test Signer';

/** The built command-line tool and the built web app: `pnpm test:integration` builds both first. */
export const CLI_BIN = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
export const WEB_DIR = fileURLToPath(new URL('../packages/web/dist', import.meta.url));

export const LINK = /http:\/\/127\.0\.0\.1:\d+\/#session=[A-Za-z0-9_-]+/;
export const nonceOf = (link: string) => new URL(link).hash.replace('#session=', '');

export interface Fixture {
  dir: string;
  pdfPath: string;
  requestPath: string;
  outPath: string;
  request: SignRequestInput;
  cleanup(): Promise<void>;
}

/** A generated one-page PDF and a request with one signature field, in a private temporary directory. */
export async function makeFixture(): Promise<Fixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sign-pdf-integration-')));
  const pdf = await fixturePdf();
  const request = await requestFor(pdf, undefined, { title: 'Integration agreement', signer: { name: SIGNER } });
  const pdfPath = join(dir, 'fixture.pdf');
  const requestPath = join(dir, 'fixture.request.json');
  await writeFile(pdfPath, pdf);
  await writeFile(requestPath, JSON.stringify(request));
  return {
    dir,
    pdfPath,
    requestPath,
    outPath: join(dir, 'fixture-signed.pdf'),
    request,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface CliExit {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunningCli {
  /** The one-time signing link, read from the command's stderr. */
  link: Promise<string>;
  done: Promise<CliExit>;
  /** Stop the process if it is still running, and wait until it is gone. */
  stop(): Promise<void>;
}

function collect(child: ChildProcess): { done: Promise<CliExit>; onStderr(listener: (all: string) => void): void } {
  let stdout = '';
  let stderr = '';
  const listeners: ((all: string) => void)[] = [];
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
    for (const listener of listeners) listener(stderr);
  });
  const done = new Promise<CliExit>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { done, onStderr: (listener) => listeners.push(listener) };
}

/** Run the built command-line tool to its end. */
export function runCli(args: string[]): Promise<CliExit> {
  return collect(spawn(process.execPath, [CLI_BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })).done;
}

/**
 * Start the real `request` command with `--no-open --json`. It picks a random
 * free port; the test learns it only from the link on stderr.
 */
export function startRequest(fixture: Fixture, extraArgs: string[] = []): RunningCli {
  const child = spawn(
    process.execPath,
    [CLI_BIN, 'request', fixture.pdfPath, fixture.requestPath, '-o', fixture.outPath, '--no-open', '--timeout', '120', '--json', ...extraArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const { done, onStderr } = collect(child);
  const link = new Promise<string>((resolve, reject) => {
    onStderr((all) => {
      const match = LINK.exec(all);
      if (match) resolve(match[0]);
    });
    void done.then((exit) => reject(new Error(`the command ended before it printed a link (code ${exit.code}): ${exit.stderr}`)));
  });
  // A test that fails before it reads the link must not leave an unhandled rejection behind.
  link.catch(() => undefined);
  return {
    link,
    done,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done.catch(() => undefined);
    },
  };
}

/** Console errors (a CSP violation is one), uncaught errors and failed or refused requests of a page. */
export function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  // Chromium reports a fetch that was answered with 204 as "failed" (net::ERR_ABORTED)
  // once the answer is complete. A request that got its answer did not fail.
  const answered = new Set<Request>();
  page.on('response', (response) => {
    answered.add(response.request());
    if (response.status() >= 400) problems.push(`status ${response.status()}: ${new URL(response.url()).pathname}`);
  });
  page.on('requestfailed', (request) => {
    const detail = request.failure()?.errorText ?? 'no detail';
    if (answered.has(request) && detail === 'net::ERR_ABORTED') return;
    problems.push(`requestfailed: ${new URL(request.url()).pathname} (${detail})`);
  });
  return problems;
}

/** Report a CSP violation even if the browser would not log it. */
export async function reportCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`);
    });
  });
}

/**
 * A slow machine: the server closes right after it takes the signed PDF, while
 * the page is still loading what it needs to show the signed document.
 */
export async function slowNetwork(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 20,
    downloadThroughput: 400 * 1024,
    uploadThroughput: 400 * 1024,
  });
}

/** Open the signing link the way a person's browser does, and wait for the sign view. */
export async function openSignView(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-state', 'awaiting-human');
  // The one-time nonce does not stay in the address bar.
  expect(page.url()).not.toContain('session=');
  expect(page.url()).not.toContain(nonceOf(link));
}

/**
 * Walk the guided sign view with its floating button as the synthetic person:
 * confirm the prefilled values, type the signature the first signature step
 * asks for, then confirm and sign.
 */
export async function signAsTestSigner(page: Page): Promise<void> {
  await expect(page.getByTestId('prefilled-name')).toBeVisible();
  await expect(page.getByTestId('guide-next')).toHaveText('Confirm');
  await page.getByTestId('guide-next').click();
  await expect(page.getByTestId('signature-dialog')).toBeVisible();
  await page.getByTestId('signature-tab-type').click();
  await page.getByTestId('signature-typed-input').fill(SIGNER);
  await page.getByTestId('signature-apply').click();
  await expect(page.getByTestId('field-done-sig')).toBeVisible();
  await expect(page.getByTestId('guide-step-title')).toHaveText('Confirm and sign');
  await page.getByTestId('signer-name').fill(SIGNER);
  await page.getByTestId('consent').check();
  await page.getByTestId('sign-button').click();
  await expect(page.getByTestId('sent-status')).toHaveText('Sent back to the requesting app. You can close this tab.');
}
