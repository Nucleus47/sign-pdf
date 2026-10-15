/**
 * Turning what the person opened (files, the sample, a session packet) into
 * something a view can work on. Every failure is a plain sentence for the page.
 */
import type { SignRequestInput } from '@sign-pdf/spec';
import { core, explainProblem, toCoreProblem, type HumanInput, type PdfInspection } from '../lib/core.ts';
import { fileFacts, type Failure, type FileFacts } from '../lib/errorReport.ts';
import {
  kindFromName,
  looksLikePacketText,
  looksLikePdf,
  parseRequestText,
  readBytes,
} from '../lib/files.ts';

/**
 * The document state. It is the `data-state` attribute of the app root and the
 * text of the status line; this list is the one place its values are defined.
 *
 * - `empty`: no document is open.
 * - `opening`: a document is being fetched or read; nothing can be done yet.
 * - `preparing`: fields are being placed in the prepare view.
 * - `awaiting-human`: the sign view is ready and waits for a person to review and sign.
 * - `cannot-sign`: the request could not be applied to the PDF; there is nothing to sign.
 * - `signed`: the signed PDF exists.
 */
export type DocState = 'empty' | 'opening' | 'preparing' | 'awaiting-human' | 'cannot-sign' | 'signed';

/** What the status line says for each state. */
export const DOC_STATE_TEXT: Record<DocState, string> = {
  empty: 'No document open',
  opening: 'Opening the document',
  preparing: 'Placing fields',
  'awaiting-human': 'Waiting for a person to review and sign',
  'cannot-sign': 'This document cannot be signed yet',
  signed: 'Signed',
};

/**
 * Would leaving this screen lose something the person entered? Only then does
 * the app ask before leaving. An error screen and a signed document hold nothing.
 */
export function hasWorkToLose(
  view: 'home' | 'connecting' | 'link-problem' | 'relay-open' | 'relay-collect' | 'prepare' | 'sign' | 'verify' | 'sent',
  preparedFields: number,
  signState: DocState,
): boolean {
  if (view === 'prepare') return preparedFields > 0;
  return view === 'sign' && signState === 'awaiting-human';
}

export interface LoadedDocument {
  name: string;
  bytes: Uint8Array;
  sha256: string;
  inspection: PdfInspection;
}

export interface SignJob {
  document: { name: string; bytes: Uint8Array };
  request: SignRequestInput;
  /** Where the job came from; decides what "back" means. */
  origin: 'prepare' | 'file' | 'session' | 'relay';
  /** Loopback session token, kept in memory only. */
  sessionToken?: string;
  /**
   * Present when the job came from a hand-off PDF: the turns other signers
   * finished on their own devices. The sign view starts at the next turn.
   * They are claims the file makes; nothing proves who made them.
   */
  handoff?: { passes: readonly HumanInput[] };
  /**
   * Present when the job came from an emailed link (origin 'relay'): what the
   * end of the turn needs to send the signed PDF back. `docKey` is the
   * derived, non-extractable document key; it stays in memory.
   */
  relay?: { id: string; docKey: CryptoKey };
}

export type Opened =
  /**
   * `request` goes on the page as the view opens (the sample's demo fields);
   * `demo` marks the sample, so the view says what it is.
   */
  | { kind: 'prepare'; document: LoadedDocument; request?: unknown; demo?: boolean }
  | { kind: 'sign'; job: SignJob }
  /** `message` is for the page; `failure` and `file` are for the error report. */
  | { kind: 'error'; message: string; failure: Failure; file?: FileFacts };

/** A failure the app itself found. `code` names it in the error report; `message` is shown. */
function fail(message: string, code: string, file?: FileFacts): Opened {
  // The report's message is the code: the shown message can name the file.
  return { kind: 'error', message, failure: { code, message: code }, ...(file ? { file } : {}) };
}

/** A failure the core (or anything else) threw. */
function failWith(error: unknown, file?: FileFacts): Opened {
  const problem = toCoreProblem(error);
  const message = problem.code === 'unknown' ? `${explainProblem(problem)} (${problem.message})` : explainProblem(problem);
  return { kind: 'error', message, failure: problem, ...(file ? { file } : {}) };
}

/** The file facts for a failure that does not have them yet. */
function withFile(opened: Opened, file: FileFacts): Opened {
  return opened.kind === 'error' && !opened.file ? { ...opened, file } : opened;
}

const factsOf = (file: Pick<File, 'name' | 'size'>): FileFacts => fileFacts(file.name, file.size);

/** A sentence when the file is over the core's size limit, checked before the file is read. */
export async function tooLargeMessage(file: Pick<File, 'name' | 'size'>): Promise<string | null> {
  const { maxPdfBytes, maxPacketChars } = await core.limits();
  const limit = kindFromName(file.name) === 'pdf' ? maxPdfBytes : Math.max(maxPdfBytes, maxPacketChars);
  if (file.size <= limit) return null;
  const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return `“${file.name}” is too large (${megabytes(file.size)} MB). The limit is ${megabytes(limit)} MB.`;
}

async function firstTooLarge(files: readonly File[]): Promise<Opened | null> {
  for (const file of files) {
    const message = await tooLargeMessage(file);
    if (message) return fail(message, 'file-too-large', factsOf(file));
  }
  return null;
}

export async function openPdfBytes(name: string, bytes: Uint8Array): Promise<Opened> {
  const file = fileFacts(name, bytes.length);
  if (!looksLikePdf(bytes)) {
    return fail(`“${name}” is not a PDF. Choose a file that ends in .pdf.`, 'not-a-pdf', file);
  }
  try {
    // A hand-off PDF from an earlier signer resumes at the next signer's turn,
    // on the original PDF it carries, never on the pages it shows.
    const handoff = await core.readHandoffPdf(bytes);
    if (handoff) {
      return {
        kind: 'sign',
        job: {
          document: { name: handoff.packet.request.document.name, bytes: handoff.pdf },
          request: handoff.packet.request,
          origin: 'file',
          handoff: { passes: handoff.passes },
        },
      };
    }
    const inspection = await core.inspectPdf(bytes);
    return { kind: 'prepare', document: { name, bytes, sha256: inspection.sha256, inspection } };
  } catch (error) {
    return failWith(error, file);
  }
}

/**
 * An emailed hand-off (issue #65), already decrypted: packet JSON bytes. It
 * resumes at the next signer's turn like a hand-off PDF. The relay's v1 is two
 * signers and one finished turn; anything else is refused as invalid hand-off data.
 */
export async function openRelayPacket(relay: { id: string; docKey: CryptoKey }, data: Uint8Array): Promise<Opened> {
  try {
    const handoff = await core.decodeHandoff(data);
    if ((handoff.packet.request.signers?.length ?? 0) !== 2 || handoff.passes.length !== 1) {
      return {
        kind: 'error',
        message: 'This document cannot be signed here: an emailed document has two signers, and one of them has signed.',
        failure: { code: 'invalid-handoff', message: 'relay-signer-count' },
      };
    }
    return {
      kind: 'sign',
      job: {
        document: { name: handoff.packet.request.document.name, bytes: handoff.pdf },
        request: handoff.packet.request,
        origin: 'relay',
        handoff: { passes: handoff.passes },
        relay,
      },
    };
  } catch (error) {
    return failWith(error);
  }
}

export async function openPacketText(text: string, sessionToken?: string): Promise<Opened> {
  try {
    const { packet, pdf } = await core.decodePacket(text);
    const job: SignJob = {
      document: { name: packet.request.document.name, bytes: pdf },
      request: packet.request,
      origin: sessionToken ? 'session' : 'file',
    };
    if (sessionToken) job.sessionToken = sessionToken;
    return { kind: 'sign', job };
  } catch (error) {
    return failWith(error);
  }
}

export async function openPdfWithRequest(pdf: File, requestFile: File): Promise<Opened> {
  const tooLarge = await firstTooLarge([pdf, requestFile]);
  if (tooLarge) return tooLarge;
  const bytes = await readBytes(pdf);
  if (!looksLikePdf(bytes)) return fail(`“${pdf.name}” is not a PDF. Choose a file that ends in .pdf.`, 'not-a-pdf', factsOf(pdf));
  const parsed = parseRequestText(await requestFile.text());
  if (!parsed.ok) return fail(parsed.error, 'invalid-request', factsOf(requestFile));
  return {
    kind: 'sign',
    job: { document: { name: pdf.name, bytes }, request: parsed.request, origin: 'file' },
  };
}

/** Work out what a set of picked or dropped files is, and open it. */
export async function openFiles(files: readonly File[]): Promise<Opened> {
  if (files.length === 0) return fail('No file was chosen.', 'no-file');
  const tooLarge = await firstTooLarge(files);
  if (tooLarge) return tooLarge;
  const pdfs = files.filter((file) => kindFromName(file.name) === 'pdf');
  const packets = files.filter((file) => kindFromName(file.name) === 'packet');
  const jsons = files.filter((file) => kindFromName(file.name) === 'json');

  const packet = packets[0];
  if (packet) return withFile(await openPacketText(await packet.text()), factsOf(packet));

  const pdf = pdfs[0];
  const json = jsons[0];
  if (pdf && json) return openPdfWithRequest(pdf, json);
  if (pdf) return openPdfBytes(pdf.name, await readBytes(pdf));
  if (json) {
    const text = await json.text();
    if (looksLikePacketText(text)) return withFile(await openPacketText(text), factsOf(json));
    return fail('Open the PDF and the request file from “A PDF with a separate request file” under the first box.', 'request-without-pdf', factsOf(json));
  }
  const first = files[0];
  if (!first) return fail('No file was chosen.', 'no-file');
  // Unknown extension: decide by content, so a PDF without ".pdf" still opens.
  const bytes = await readBytes(first);
  if (looksLikePdf(bytes)) return openPdfBytes(first.name, bytes);
  return fail(`“${first.name}” is not a PDF. Choose a file that ends in .pdf.`, 'not-a-pdf', factsOf(first));
}

/** The sample is the agent demo (docs/demo.md): the NDA with no form fields, and its five demo fields. */
export const SAMPLE_NAME = 'demo-nda.pdf';
export const SAMPLE_REQUEST = 'demo-request.json';

/** The bundled sample: two of the site's own static files, opened in prepare with the demo fields on the page. */
export async function openSample(): Promise<Opened> {
  try {
    const [pdf, request] = await Promise.all(
      [SAMPLE_NAME, SAMPLE_REQUEST].map((name) => fetch(`${import.meta.env.BASE_URL}${name}`)),
    );
    for (const response of [pdf, request]) {
      if (!response?.ok) return fail('The sample document could not be loaded.', `sample-http-${response?.status ?? 0}`);
    }
    const opened = await openPdfBytes(SAMPLE_NAME, new Uint8Array(await pdf!.arrayBuffer()));
    return opened.kind === 'prepare' ? { ...opened, request: (await request!.json()) as unknown, demo: true } : opened;
  } catch (error) {
    return failWith(error);
  }
}
