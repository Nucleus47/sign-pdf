#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const smokeArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const out = resolve(smokeArgs[0] ?? process.env.SIGN_PDF_RELEASE_DIR ?? '');
if (!smokeArgs[0] && !process.env.SIGN_PDF_RELEASE_DIR) throw new Error('smoke-packed: pass the artifact output directory');
const summary = JSON.parse(await readFile(join(out, 'release-summary.json'), 'utf8'));
const packages = JSON.parse(await readFile(join(root, 'scripts/release/packages.json'), 'utf8')).packages;
const tarballs = new Map(packages.map((entry) => [entry.name, join(out, summary.packages.find((item) => item.name === entry.name).filename)]));
const cliEntry = packages.find((entry) => entry.kind === 'cli');
const mcpEntry = packages.find((entry) => entry.kind === 'mcp');
const cliSummary = summary.packages.find((item) => item.name === cliEntry.name);
const mcpSummary = summary.packages.find((item) => item.name === mcpEntry.name);
const cliCommand = Object.keys(cliSummary.bin)[0];
const mcpCommand = Object.keys(mcpSummary.bin)[0];
const scratch = await mkdtemp(join(tmpdir(), 'sign-pdf-packed-smoke-'));

function check(condition, message) {
  if (!condition) throw new Error(`smoke-packed: ${message}`);
}

async function run(command, args, options = {}) {
  return await execFileAsync(command, args, { cwd: options.cwd ?? scratch, env: options.env ?? process.env, maxBuffer: 10 * 1024 * 1024 });
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: scratch, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

function npxArgs(tarball, bin, args = []) {
  return ['--yes', '--offline', '--package', tarball, bin, ...args];
}

async function getPdfLib() {
  const require = createRequire(join(root, cliEntry.workspace, 'package.json'));
  return import(pathToFileURL(require.resolve('@cantoo/pdf-lib')).href);
}

const requireMcp = createRequire(join(root, mcpEntry.workspace, 'package.json'));
const { Client } = await import(pathToFileURL(requireMcp.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(requireMcp.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);

async function makeSyntheticPdf() {
  const { PDFDocument, StandardFonts, rgb } = await getPdfLib();
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Synthetic sign-pdf release smoke test', { x: 72, y: 720, size: 14, font, color: rgb(0, 0, 0) });
  page.drawText('Signature:', { x: 72, y: 650, size: 12, font, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: 155, y: 648 }, end: { x: 420, y: 648 }, thickness: 0.7, color: rgb(0, 0, 0) });
  page.drawText('Date:', { x: 72, y: 600, size: 12, font, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: 110, y: 598 }, end: { x: 250, y: 598 }, thickness: 0.7, color: rgb(0, 0, 0) });
  const path = join(scratch, 'synthetic.pdf');
  await writeFile(path, await document.save());
  return path;
}

function baseEnv(extra = {}) {
  const env = { ...process.env };
  delete env['SIGN_PDF_WEB_DIR'];
  delete env['SIGN_PDF_NO_OPEN'];
  Object.assign(env, extra);
  env['SIGN_PDF_OUTPUT_DIR'] = scratch;
  return env;
}

async function withMcp(args, env, work) {
  const client = new Client({ name: 'packed-artifact-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'npx', args, cwd: scratch, env, stderr: 'inherit' });
  const protocolErrors = [];
  client.onerror = (error) => protocolErrors.push(String(error));
  try {
    await client.connect(transport);
    await work(client);
    check(protocolErrors.length === 0, `MCP stdio had protocol errors: ${protocolErrors.join('; ')}`);
  } finally {
    await client.close();
  }
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
  return { result, text, data: result.structuredContent ?? JSON.parse(text || '{}') };
}

try {
  const tarballArgs = [...tarballs.values()];
  await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', scratch, ...tarballArgs]);

  const cliBin = join(scratch, 'node_modules', ...cliEntry.name.split('/'), 'dist/bin.js');
  const mcpBin = join(scratch, 'node_modules', ...mcpEntry.name.split('/'), 'dist/bin.js');
  const cliVersion = await run(process.execPath, [cliBin, '--version']);
  const mcpVersion = await run(process.execPath, [mcpBin, '--version']);
  check(cliVersion.stdout.trim() === cliSummary.version, `CLI --version failed: ${cliVersion.stdout} ${cliVersion.stderr}`);
  check(mcpVersion.stdout.trim() === mcpSummary.version, `MCP --version failed: ${mcpVersion.stdout} ${mcpVersion.stderr}`);
  check((await run('npx', npxArgs(tarballs.get(cliEntry.name), cliCommand, ['--version']))).stdout.trim() === cliVersion.stdout.trim(), 'npx CLI --version did not match the packed CLI');

  const pdfPath = await makeSyntheticPdf();
  const mcpEnv = baseEnv({ SIGN_PDF_NO_OPEN: '1' });
  await withMcp(npxArgs(tarballs.get(mcpEntry.name), mcpCommand), mcpEnv, async (client) => {
    const inspected = await call(client, 'inspect_pdf', { pdf_path: pdfPath, detail: 'summary' });
    check(!inspected.result.isError && inspected.data.page_count === 1, `inspect_pdf failed: ${inspected.text}`);

    const found = await call(client, 'find_candidates', { pdf_path: pdfPath });
    check(!found.result.isError && found.data.candidate_count > 0, `find_candidates found no candidate: ${found.text}`);

    const drafted = await call(client, 'draft_request', { pdf_path: pdfPath });
    check(!drafted.result.isError && drafted.data.untrusted_document_content?.request, `draft_request failed: ${drafted.text}`);
    const request = drafted.data.untrusted_document_content.request;

    const validated = await call(client, 'validate_request', { pdf_path: pdfPath, request });
    check(!validated.result.isError && validated.data.ok === true && validated.data.fields.length > 0, `validate_request failed: ${validated.text}`);

    const preview = await call(client, 'render_preview', { pdf_path: pdfPath, request });
    check(!preview.result.isError && preview.result.content.some((item) => item.type === 'image'), `render_preview returned no image: ${preview.text}`);

    const handoff = await call(client, 'request_signature', { pdf_path: pdfPath, request });
    check(handoff.result.isError && handoff.data.error?.code === 'browser-unavailable', `request_signature did not resolve the bundled web assets before the no-open failure: ${handoff.text}`);
  });

  // This reaches web-dir resolution with an invalid override. It must return an actionable tool error, not a stack trace.
  const missingEnv = baseEnv({ SIGN_PDF_WEB_DIR: join(scratch, 'missing-web-assets'), SIGN_PDF_NO_OPEN: '1' });
  await withMcp(npxArgs(tarballs.get(mcpEntry.name), mcpCommand), missingEnv, async (client) => {
    const { result, text, data } = await call(client, 'request_signature', {
      pdf_path: pdfPath,
      request: (await call(client, 'draft_request', { pdf_path: pdfPath })).data.untrusted_document_content.request,
    });
    const error = data.error;
    check(result.isError && error?.code === 'web-dir-missing', `expected web-dir-missing, got ${text}`);
    check(typeof error.hint === 'string' && !text.includes(' at ') && !text.includes('stack'), `missing-web-assets error had no hint or showed a stack: ${text}`);
  });

  const preload = join(scratch, 'old-node.mjs');
  await writeFile(preload, `Object.defineProperty(process, 'version', { value: 'v20.0.0' });\n`);
  for (const [name, bin] of [['CLI', cliBin], ['MCP', mcpBin]]) {
    const result = await spawnCapture(process.execPath, ['--import', preload, bin, '--version'], { env: baseEnv() });
    check(result.code === 1 && result.stderr.includes('requires Node.js 22 or later') && result.stderr.includes('hint: Install Node.js 22 or later'), `${name} old-Node check lacked its hint: ${result.stderr}`);
    check(!result.stderr.includes(' at ') && !result.stderr.includes('Error:'), `${name} old-Node check printed a stack: ${result.stderr}`);
  }

  console.log(`smoke-packed: no-checkout install in ${scratch}`);
  console.log('smoke-packed: CLI and MCP tarball --version and npx CLI --version passed');
  console.log('smoke-packed: npx MCP stdio flow inspect_pdf -> find_candidates -> draft_request -> validate_request -> render_preview passed on a generated synthetic PDF');
  console.log('smoke-packed: missing-web-assets and simulated Node 20 failures included hints and no stack traces');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
