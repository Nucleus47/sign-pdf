/**
 * The whole hand-off as one call, shared by `sign-pdf request` and the MCP
 * `request_signature` tool: check the request, start the loopback session, open
 * the browser, and save what the human sends back.
 */
import { resolve } from 'node:path';
import { createPacket, validateRequestAgainstPdf } from '@sign-pdf/core';
import type { Signer } from '@sign-pdf/spec';
import { AUDIT_NOTICE, summarizeAudit, type AuditSummary } from './audit.ts';
import { CliError, ValidationFailedError } from './errors.ts';
import { checkOutputPath, defaultSignedPath, nextFreePath, readPdfFile, writeOutputFile, writeToFreePath } from './files.ts';
import { openInDefaultBrowser, type BrowserOpener } from './open-browser.ts';
import { startSignSession, type SignSession, type SignedDocument } from './session.ts';
import { resolveWebDir } from './web-dir.ts';

export const DEFAULT_TIMEOUT_SECONDS = 1800;

export interface SignRequestOptions {
  pdfPath: string;
  /** The sign request, as parsed JSON. Validated here. */
  request: unknown;
  /** Default: `<name>-signed.pdf` next to the input. */
  outPath?: string;
  /** Replace an existing output file (atomically). */
  force?: boolean;
  /**
   * What to do when the output file already exists at the start and `force`
   * is not set: `fail` (default) or plan to write the next free numbered name.
   * A file that appears later never fails the hand-off: see `SignOutcome.path`.
   */
  ifExists?: 'fail' | 'next-free';
  /** Other files that were read to make the request; the output must not be any of them. */
  inputPaths?: readonly string[];
  webDir?: string;
  port?: number;
  timeoutSeconds?: number;
  /** Open the default browser. Default true. */
  open?: boolean;
  openBrowser?: BrowserOpener;
  maxBodyBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export type SignOutcome =
  | {
      status: 'signed';
      /** Where the signed PDF was actually written. It differs from the planned path if that name was taken. */
      path: string;
      sha256: string;
      /** Always `unverified`: see `auditNotice`. */
      integrity: 'unverified';
      auditNotice: string;
      /** Untrusted content read from the file's audit record. */
      audit: AuditSummary;
      /** Untrusted: findings about the audit record, which may quote it. */
      problems: string[];
    }
  | { status: 'declined'; reason?: string }
  /**
   * A signer downloaded a hand-off PDF for the next signer, who signs on another
   * device. No file was written: the final signed PDF arrives by other means.
   * Signer ids in request order.
   */
  | { status: 'handed_off'; signed: string[]; pending: string[] }
  | { status: 'timeout' }
  /** `locked`: too many wrong attempts to open the signing link; see `MAX_BAD_NONCES`. */
  | { status: 'cancelled'; reason?: 'locked' };

export interface PendingSignRequest {
  /** `http://127.0.0.1:<port>`: safe to show; it is not enough to open the session. */
  origin: string;
  /**
   * The one-time signing link. A secret until the human's browser has opened
   * it: show it only to the human (stderr), never to an agent or on stdout.
   */
  link: string;
  /** Where the signed PDF is planned to go. The outcome reports where it went. */
  outPath: string;
  expiresAt: Date;
  /** Whether the browser was started with the link. */
  browserOpened: boolean;
  /** The request's signers, who sign in turn. Empty for a request without `signers`. */
  signers: Signer[];
  /** Settles once, after the server has closed. Never rejects. */
  outcome: Promise<SignOutcome>;
  /** Stop waiting and close the server. */
  cancel(): Promise<void>;
}

/**
 * A sentence that says the signers sign one after another, or undefined for a
 * request without `signers`. Names come from the request, so they are quoted
 * as data.
 */
export function signersInTurnText(signers: readonly Signer[]): string | undefined {
  if (signers.length === 0) return undefined;
  const list = signers.map((signer) => (signer.name ? `${signer.id} (${JSON.stringify(signer.name)})` : signer.id)).join(', ');
  return (
    `${signers.length} signer(s) sign in turn, in this order: ${list}. Each signer signs only their own fields. ` +
    'After a signer finishes, the next signer can sign in the same browser, or the signer can download a hand-off PDF for the next signer to open on another device.'
  );
}

/**
 * What to tell the human or the agent after a hand-off to another device.
 * Signer ids come from the request.
 */
export function handedOffText(outcome: { signed: readonly string[]; pending: readonly string[] }): string {
  return (
    `Handed off: signed by ${outcome.signed.join(', ')}; still to sign: ${outcome.pending.join(', ')}. ` +
    'The signer downloaded a hand-off PDF for the next signer, who opens it on another device. ' +
    'No signed PDF was written here: the final signed PDF arrives by other means (for example by email from the last signer).'
  );
}

/**
 * Start a hand-off. Throws before any server starts when the PDF, the request,
 * the output path or the web directory is unusable.
 */
export async function startSignRequest(options: SignRequestOptions): Promise<PendingSignRequest> {
  const pdf = await readPdfFile(options.pdfPath);
  const { report, resolved } = await validateRequestAgainstPdf(pdf, options.request);
  if (!resolved) throw new ValidationFailedError(report);

  const force = options.force ?? false;
  const inputs = [options.pdfPath, ...(options.inputPaths ?? [])];
  let outPath = resolve(options.outPath ?? defaultSignedPath(options.pdfPath));
  if (!force && options.ifExists === 'next-free') outPath = await nextFreePath(outPath, { inputs });
  else await checkOutputPath(outPath, { force, inputs });
  const webDir = await resolveWebDir(options.webDir, options.env);
  const packet = await createPacket(pdf, resolved.request);

  /**
   * Save a returned document. A name that was taken since the start (another
   * session with the same default name, say) is not an error: the document
   * goes to the next free name. Only a write that cannot succeed throws.
   */
  const save = (signed: SignedDocument): Promise<string> =>
    force
      ? writeOutputFile(outPath, signed.pdf, { force, inputs }).then(() => outPath)
      : writeToFreePath(outPath, signed.pdf, { inputs });

  let savedPath: string | undefined;
  /** An accepted document that could not be saved yet. Kept so it is not lost if the browser goes away. */
  let unsaved: SignedDocument | undefined;
  const session: SignSession = await startSignSession({
    packet,
    webDir,
    timeoutMs: (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    onSigned: async (signed) => {
      unsaved = signed;
      savedPath = await save(signed);
      unsaved = undefined;
    },
  });

  let browserOpened = false;
  if (options.open !== false) {
    try {
      await (options.openBrowser ?? openInDefaultBrowser)(session.url);
      browserOpened = true;
    } catch {
      // The caller decides what to do: the CLI shows the link to the human, the MCP server gives up.
    }
  }

  const signedOutcome = (signed: Pick<SignedDocument, 'sha256' | 'audit' | 'problems'>, path: string): SignOutcome => ({
    status: 'signed',
    path,
    sha256: signed.sha256,
    integrity: 'unverified',
    auditNotice: AUDIT_NOTICE,
    audit: summarizeAudit(signed.audit),
    problems: signed.problems,
  });

  const outcome = session.result.then(async (result): Promise<SignOutcome> => {
    if (result.status === 'signed') return signedOutcome(result, savedPath ?? outPath);
    if (unsaved) {
      // The human signed, but saving failed and the session then ended. Try once more before giving up.
      const kept = unsaved;
      try {
        return signedOutcome(kept, await save(kept));
      } catch {
        return result;
      }
    }
    return result;
  });

  return {
    origin: session.origin,
    link: session.url,
    outPath,
    expiresAt: session.expiresAt,
    browserOpened,
    signers: resolved.request.signers ?? [],
    outcome,
    cancel: () => session.close(),
  };
}

/** The error for a hand-off whose browser could not be started and whose link must not be passed on. */
export function browserUnavailableError(): CliError {
  return new CliError(
    'browser-unavailable',
    'The browser could not be opened on this computer, so the document was not shown to the user.',
    'Ask the user to run the sign-pdf CLI themselves in a terminal: sign-pdf request <pdf> <request.json>. Do not try to open the sign view yourself.',
  );
}
