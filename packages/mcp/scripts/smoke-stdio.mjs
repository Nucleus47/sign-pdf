// Smoke test of the built MCP server over real stdio. Runs at the end of `build`.
//
// Part 1 uses the SDK's client: list the tools, inspect and find candidates on the sample
// NDA, draft and validate a request, then render its preview.
// Part 2 speaks JSON-RPC to a second server by hand. With SIGN_PDF_NO_OPEN set, the
// browser cannot be opened: request_signature must fail with `browser-unavailable`, give
// no link and leave no session.
// Part 3 (not on Windows) starts a third server whose browser launcher is a stand-in
// script that does nothing, starts a signature session and closes stdin: the process
// must exit by itself with code 0 and the session's loopback server must be gone.
//
// No real browser is ever started: part 1 and 2 run with SIGN_PDF_NO_OPEN, and part 3
// puts the stand-in launcher first on PATH and checks that it was the one that ran.
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const BIN = here('../dist/bin.js');
const PDF = here('../../web/public/sample-nda.pdf');
const REQUEST = JSON.parse(await readFile(here('../../cli/examples/sample-nda.request.json'), 'utf8'));
const ENV = { ...process.env, SIGN_PDF_NO_OPEN: '1' };
const EXIT_LIMIT_MS = 10_000;

function check(condition, message) {
  if (!condition) throw new Error(`smoke-stdio: ${message}`);
}

function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

async function withSdkClient() {
  const client = new Client({ name: 'smoke-stdio', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: ENV, stderr: 'inherit' });
  // Anything on the server's stdout that is not a protocol message arrives here.
  const protocolErrors = [];
  client.onerror = (error) => protocolErrors.push(String(error));
  await client.connect(transport);
  const pid = transport.pid;
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    check(names.length === 10, `expected 10 tools, got ${names.join(', ')}`);
    check(!names.some((name) => /^sign|finalize/.test(name)), 'a tool offers to sign');
    for (const tool of tools) {
      const argumentNames = Object.keys(tool.inputSchema.properties ?? {});
      check(!argumentNames.some((name) => name === 'force' || name === 'open_browser'), `${tool.name} takes force or open_browser`);
      check(typeof tool.annotations?.readOnlyHint === 'boolean' && tool.annotations.openWorldHint === false, `${tool.name} has incomplete annotations`);
    }
    check(!JSON.stringify(tools).includes('#session='), 'a tool description names a signing link');

    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      check(result.isError !== true, `${name} failed: ${result.content[0]?.text}`);
      return { data: JSON.parse(result.content[0].text), content: result.content };
    };

    const inspected = (await call('inspect_pdf', { pdf_path: PDF })).data;
    check(inspected.sha256 === REQUEST.document.sha256, 'inspect_pdf: the sample PDF does not have the hash in the example request');
    const { untrusted_document_content: fromDocument, ...plain } = inspected;
    check(fromDocument.text.length > 0 && fromDocument.form_fields.length > 0, 'inspect_pdf: no text or form fields');
    check(Object.keys(plain).sort().join() === 'page_count,pages,sha256', 'inspect_pdf: document content outside the labelled field');

    const found = (await call('find_candidates', { pdf_path: PDF })).data;
    check(found.untrusted_document_content.candidates.length > 0, 'find_candidates: no candidates on the sample PDF');
    check(!JSON.stringify({ ...found, untrusted_document_content: undefined }).includes('Signature'), 'find_candidates: document content outside the labelled field');

    const drafted = (await call('draft_request', { pdf_path: PDF, candidates: [4, 5, 8, 9, 10] })).data;
    check(drafted.untrusted_document_content.request.fields.length === 5, 'draft_request: did not return the selected fields');
    check(drafted.fields.map((field) => field.candidate_number).join() === '4,5,8,9,10', 'draft_request: candidate mapping is wrong');
    check(drafted.skipped.length === 8 && drafted.skipped.every((entry) => entry.reason), 'draft_request: skipped candidates have no reason');
    const validated = (await call('validate_request', { pdf_path: PDF, request: drafted.untrusted_document_content.request })).data;
    check(validated.ok === true && validated.errors.length === 0, `validate_request: ${JSON.stringify(validated.errors)}`);
    check(validated.fields.length === drafted.fields.length, 'validate_request: not every field resolved');

    const preview = await call('render_preview', { pdf_path: PDF, request: drafted.untrusted_document_content.request });
    const images = preview.content.filter((item) => item.type === 'image');
    check(images.length === preview.data.images.length && images.length > 0, 'render_preview: no images');
    for (const image of images) {
      check(Buffer.from(image.data, 'base64').subarray(1, 4).toString('latin1') === 'PNG', 'render_preview: not a PNG');
    }

    const audit = (await call('verify_signed_pdf', { pdf_path: PDF })).data;
    check(audit.has_audit_record === false && audit.integrity === 'unverified', 'verify_signed_pdf: wrong answer for an unsigned PDF');
    check(Array.isArray(audit.untrusted_problems) && !('problems' in audit), 'verify_signed_pdf: findings are not under untrusted_problems');
    check(!/\bvalid\b|verified/i.test(JSON.stringify(audit).replaceAll('unverified', '')), 'verify_signed_pdf: says "valid" or "verified"');

    check(protocolErrors.length === 0, `the server wrote something that is not a protocol message: ${protocolErrors.join('; ')}`);
    console.log(
      `smoke-stdio: ${names.length} tools; inspect, find, draft, validate (${validated.fields.length} fields) and preview (${images.length} image(s)) passed`,
    );
  } finally {
    await client.close();
  }
  return pid;
}

/** A line-delimited JSON-RPC peer over a child's stdio, enough for a few calls. */
function rawServer(env) {
  const child = spawn(process.execPath, [BIN], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let nextId = 1;
  return {
    child,
    exited,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    request(method, params) {
      const id = nextId++;
      const reply = new Promise((resolve) => waiting.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return reply;
    },
  };
}

async function startRaw(env) {
  const server = rawServer(env);
  const hello = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-stdio-raw', version: '0.0.0' },
  });
  check(hello.result?.serverInfo?.name === 'sign-pdf', `initialize: ${JSON.stringify(hello)}`);
  server.notify('notifications/initialized');
  return server;
}

/** Run `work` against a raw server; kill the server and fail loudly if nothing settles in time. */
async function withRawServer(env, work) {
  let server;
  const killer = setTimeout(() => {
    server?.child.kill('SIGKILL');
    console.error(`smoke-stdio: no result within ${EXIT_LIMIT_MS} ms; the server was killed`);
    process.exit(1);
  }, EXIT_LIMIT_MS);
  try {
    server = await startRaw(env);
    await work(server);
    return server.child.pid;
  } finally {
    clearTimeout(killer);
    if (server && server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
  }
}

async function endByClosingStdin(server) {
  const before = Date.now();
  server.child.stdin.end();
  const { code, signal } = await server.exited;
  check(code === 0 && signal === null, `after stdin closed the process ended with code ${code}, signal ${signal}`);
  return Date.now() - before;
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function webDirIn(dir) {
  const web = join(dir, 'web');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<!doctype html><title>smoke sign view</title>');
  return web;
}

/** With no browser, request_signature gives up: an error without a link, and nothing left waiting. */
async function noBrowserMeansNoSession() {
  const dir = await mkdtemp(join(tmpdir(), 'sign-pdf-smoke-'));
  try {
    const env = { ...ENV, SIGN_PDF_WEB_DIR: await webDirIn(dir), SIGN_PDF_OUTPUT_DIR: dir };
    return await withRawServer(env, async (server) => {
      const started = await server.request('tools/call', {
        name: 'request_signature',
        arguments: { pdf_path: PDF, request: REQUEST, output_path: join(dir, 'sample-nda-signed.pdf') },
      });
      const text = JSON.stringify(started.result);
      check(started.result?.isError === true, `request_signature did not fail without a browser: ${text}`);
      check(started.result.structuredContent?.error?.code === 'browser-unavailable', `request_signature: wrong error: ${text}`);
      check(!text.includes('session=') && !text.includes('127.0.0.1'), 'request_signature: the error names a link or an address');
      check(text.includes('sign-pdf request <pdf> <request.json>'), 'request_signature: the error does not name the CLI command');

      const outside = await server.request('tools/call', {
        name: 'create_packet',
        arguments: { pdf_path: PDF, request: REQUEST, output_path: join(tmpdir(), 'sign-pdf-smoke-not-allowed.signpacket.json') },
      });
      check(outside.result?.structuredContent?.error?.code === 'output-not-allowed', `create_packet outside the allowed directories: ${JSON.stringify(outside.result)}`);

      const ms = await endByClosingStdin(server);
      console.log(`smoke-stdio: without a browser request_signature failed with browser-unavailable and no link; the server exited (code 0) in ${ms} ms`);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A launcher that starts nothing. It only leaves a mark, so the test can tell that it ran. */
async function standInLauncher(dir) {
  const bin = join(dir, 'bin');
  await mkdir(bin);
  for (const name of ['open', 'xdg-open']) {
    await writeFile(join(bin, name), '#!/bin/sh\n: > "$(dirname "$0")/launched"\n');
    await chmod(join(bin, name), 0o755);
  }
  return { bin, mark: join(bin, 'launched') };
}

async function closingStdinEndsTheProcess() {
  const dir = await mkdtemp(join(tmpdir(), 'sign-pdf-smoke-'));
  try {
    const launcher = await standInLauncher(dir);
    const { SIGN_PDF_NO_OPEN: _never, ...rest } = ENV;
    const env = { ...rest, PATH: `${launcher.bin}${delimiter}${process.env.PATH ?? ''}`, SIGN_PDF_WEB_DIR: await webDirIn(dir), SIGN_PDF_OUTPUT_DIR: dir };
    return await withRawServer(env, async (server) => {
      const started = await server.request('tools/call', {
        name: 'request_signature',
        arguments: { pdf_path: PDF, request: REQUEST, output_path: join(dir, 'sample-nda-signed.pdf') },
      });
      const text = JSON.stringify(started.result);
      check(started.result?.isError !== true, `request_signature: ${started.result?.content?.[0]?.text}`);
      const session = JSON.parse(started.result.content[0].text);
      check(session.status === 'pending' && session.browser_opened === true, 'request_signature: not pending');
      check(!('url' in session) && !text.includes('session='), 'request_signature: the result holds a signing link');
      for (let tries = 0; tries < 50 && !(await exists(launcher.mark)); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
      check(await exists(launcher.mark), 'the stand-in launcher did not run');
      const port = Number(new URL(session.origin).port);
      check(!(await portIsClosed(port)), 'the session server is not listening');

      const ms = await endByClosingStdin(server);
      check(await portIsClosed(port), 'the session server outlived the process');
      console.log(`smoke-stdio: stdin closed with a pending session; the server exited by itself (code 0) in ${ms} ms; port ${port} closed`);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pids = [await withSdkClient(), await noBrowserMeansNoSession()];
if (process.platform === 'win32') console.log('smoke-stdio: the pending-session part is skipped on Windows (no stand-in launcher)');
else pids.push(await closingStdinEndsTheProcess());
for (const pid of pids) check(!isRunning(pid), `server process ${pid} is still running`);
console.log('smoke-stdio: ok, no server process left running');
