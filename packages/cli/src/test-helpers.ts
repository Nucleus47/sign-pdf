/**
 * Test-only helpers: synthetic fixtures built in code, and a stand-in for the
 * human in the browser. Not part of the package's public API and never bundled.
 *
 * This is the one place outside the web app that imports `@sign-pdf/core/sign`:
 * a test has to play the human to exercise the hand-off.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { decodePacket, resolveRequest, sha256Hex } from '@sign-pdf/core';
import { buildHandoffPdf, finalizeDocument, type HumanInput, type HumanSignature } from '@sign-pdf/core/sign';
import { isSigningField, type FieldInput, type SignRequestInput } from '@sign-pdf/spec';
import { run, type CliIo } from './cli.ts';

export interface FixtureOptions {
  /** Extra text on the first line, to make a different document. */
  title?: string;
  pages?: number;
  /** `/Rotate` of the first page, clockwise. With 90 or 270 the page is displayed 792 x 612. */
  rotate?: 0 | 90 | 180 | 270;
}

/**
 * A US Letter page with a heading, a `Signature:` label whose baseline is 580
 * points from the top, a `Date:` label, and one text form field named `full_name`.
 */
export async function fixturePdf(options: FixtureOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  if (options.rotate) page.setRotation(degrees(options.rotate));
  page.drawText(options.title ?? 'Agreement between Example Co and Sample LLC', { x: 72, y: 720, size: 12, font });
  page.drawText('Signature:', { x: 72, y: 212, size: 12, font });
  page.drawText('Date:', { x: 340, y: 212, size: 12, font });
  const field = doc.getForm().createTextField('full_name');
  field.addToPage(page, { x: 72, y: 600, width: 200, height: 20, font });
  for (let extra = 1; extra < (options.pages ?? 1); extra++) {
    doc.addPage([612, 792]).drawText(`Appendix ${extra}`, { x: 72, y: 720, size: 12, font });
  }
  return doc.save();
}

export const rect = (page: number, x: number, y: number, width: number, height: number) =>
  ({ kind: 'rect', page, x, y, width, height }) as const;

/** A signature box right of `Signature:` and an agent-filled name. */
export const DEFAULT_FIELDS: FieldInput[] = [
  {
    id: 'sig',
    type: 'signature',
    assignee: 'human',
    placement: { kind: 'anchor', text: 'Signature:', align: 'right', dx: 6, width: 180, height: 36 },
  },
  { id: 'name', type: 'text', assignee: 'agent', value: 'Ada Example', placement: rect(1, 72, 300, 200, 20) },
];

export async function requestFor(
  pdf: Uint8Array,
  fields: FieldInput[] = DEFAULT_FIELDS,
  extra: Partial<SignRequestInput> = {},
): Promise<SignRequestInput> {
  // A copy, so a test that edits its request cannot change DEFAULT_FIELDS for the tests after it.
  return { version: 1, document: { name: 'fixture.pdf', sha256: await sha256Hex(pdf) }, fields: structuredClone(fields), ...extra };
}

/** A solid, opaque PNG of the given size. */
export function makePng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type));
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc32(body));
    return out;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  return Buffer.concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** A synthetic scanned-style PDF with one painted image XObject and no text. */
export async function imageOnlyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const image = await doc.embedPng(makePng(2, 2));
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  return doc.save();
}

type Resolved = Awaited<ReturnType<typeof resolveRequest>>;

/** One pass for the signer `signerId`, or for the only signer when it is undefined. */
function humanPass(resolved: Resolved, signerId?: string, signerName = 'Ada Example'): HumanInput {
  const signatures: Record<string, HumanSignature> = {};
  for (const field of resolved.fields) {
    if (isSigningField(field) && field.signerId === signerId) signatures[field.id] = { png: makePng(60, 20), method: 'drawn' };
  }
  return {
    ...(signerId !== undefined ? { signerId } : {}),
    signerName,
    consent: { text: 'I agree to sign this document electronically.', acceptedAt: '2031-03-04T09:59:00.000Z' },
    values: {},
    signatures,
    signedAt: '2031-03-04T10:00:00.000Z',
  };
}

/**
 * What the sign view does once the human has drawn a signature: finalize the
 * packet's document. Only tests call this.
 */
export async function signAsHuman(packetText: string): Promise<{ pdf: Uint8Array; sha256: string }> {
  const { packet, pdf } = await decodePacket(packetText);
  const resolved = await resolveRequest(pdf, packet.request);
  const signers = packet.request.signers;
  const result = await finalizeDocument(
    pdf,
    resolved,
    signers ? signers.map((signer, index) => humanPass(resolved, signer.id, `Signer ${index + 1}`)) : humanPass(resolved),
  );
  return { pdf: result.pdf, sha256: result.sha256 };
}

/**
 * What the sign view does when the first `count` signers have signed and the
 * last of them downloads a hand-off PDF for the next signer. Only tests call this.
 */
export async function handoffAsHuman(packetText: string, count = 1): Promise<Uint8Array> {
  const { packet, pdf } = await decodePacket(packetText);
  const resolved = await resolveRequest(pdf, packet.request);
  const signers = (packet.request.signers ?? []).slice(0, count);
  const result = await buildHandoffPdf(
    pdf,
    resolved,
    signers.map((signer, index) => humanPass(resolved, signer.id, `Signer ${index + 1}`)),
  );
  return result.pdf;
}

export interface Workspace {
  dir: string;
  path(name: string): string;
  write(name: string, data: Uint8Array | string): Promise<string>;
  /** A stand-in for the built web app. */
  webDir(): Promise<string>;
  cleanup(): Promise<void>;
}

export const FIXTURE_INDEX_HTML = '<!doctype html><title>fixture sign view</title><script src="/assets/app.js"></script>';

export async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'sign-pdf-test-'));
  const path = (name: string) => join(dir, name);
  const write = async (name: string, data: Uint8Array | string) => {
    await writeFile(path(name), data);
    return path(name);
  };
  return {
    dir,
    path,
    write,
    webDir: async () => {
      await mkdir(path('web/assets'), { recursive: true });
      await write('web/index.html', FIXTURE_INDEX_HTML);
      await write('web/assets/app.js', 'console.log("fixture");');
      await write('secret.txt', 'outside the web dir');
      return path('web');
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON. Throws when it is not JSON. */
  json<T = Record<string, unknown>>(): T;
}

/** Run the CLI in-process. The browser opener is a no-op unless one is given. */
export async function runCli(args: string[], io: Partial<CliIo> = {}): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    stdout: (text) => {
      stdout += text;
      io.stdout?.(text);
    },
    stderr: (text) => {
      stderr += text;
      io.stderr?.(text);
    },
    openBrowser: io.openBrowser ?? (() => undefined),
    env: io.env ?? {},
    ...(io.signal ? { signal: io.signal } : {}),
  });
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
}

export interface HttpReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json<T = { error?: string; code?: string }>(): T;
}

/** A raw HTTP call to 127.0.0.1, with full control of the headers (Host included). */
export function http(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: Uint8Array | string },
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: <T>() => JSON.parse(body.toString('utf8')) as T });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** True when nothing listens on the port any more. */
export async function isClosed(port: number): Promise<boolean> {
  try {
    await http(port, {});
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED';
  }
}

/**
 * What the sign view does first: take the one-time nonce from the signing link
 * (`http://127.0.0.1:<port>/#session=<nonce>`) and exchange it for the session
 * token. Throws when the exchange is refused.
 */
export async function exchangeNonce(port: number, link: string): Promise<string> {
  const nonce = new URL(link).hash.replace(/^#session=/, '');
  const reply = await http(port, {
    method: 'POST',
    path: '/api/session',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  if (reply.status !== 200) throw new Error(`The nonce exchange failed: ${reply.status} ${reply.body.toString('utf8')}`);
  const { token } = reply.json<{ token?: unknown }>();
  if (typeof token !== 'string' || token === '') throw new Error('The nonce exchange returned no token.');
  return token;
}

/** The whole human side of a hand-off: open the link, fetch the packet, sign it and send it back. */
export async function signInBrowser(link: string): Promise<HttpReply> {
  const port = Number(new URL(link).port);
  const headers = { Authorization: `Bearer ${await exchangeNonce(port, link)}` };
  const packet = await http(port, { path: '/api/packet', headers });
  const signed = await signAsHuman(packet.body.toString());
  return http(port, {
    method: 'POST',
    path: '/api/signed',
    headers: { ...headers, 'Content-Type': 'application/pdf', 'X-Sign-Pdf-Sha256': signed.sha256 },
    body: signed.pdf,
  });
}
