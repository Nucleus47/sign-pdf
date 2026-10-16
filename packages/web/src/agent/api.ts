/**
 * The browser agent API: the MCP server's prepare-side tools, run on the PDF
 * open in the prepare view. `window.signPdf` and WebMCP are thin adapters over
 * it (expose.ts, webmcp.ts); the paste box uses apply_request.
 *
 * Every method takes one input object, checked against the shared catalog's
 * shape (@sign-pdf/core/tools), and returns the same object the MCP tool returns
 * as `structuredContent`. A failure comes back as `{ error, ... }`; nothing
 * throws. Document text is only ever under keys that start with `untrusted_`.
 *
 * Nothing here signs, fills a signature or initials, ticks the consent or
 * touches the sign view: the API exists only while the prepare view is
 * mounted, and its only write is the draft the human then reviews.
 */
import {
  BROWSER_TOOLS,
  BROWSER_WORKFLOW,
  INVALID_REQUEST_MESSAGE,
  REJECTED_MESSAGE,
  UNEXPECTED_MESSAGE,
  UNTRUSTED_NOTICE,
  candidatesOut,
  inspectionOut,
  parseToolInput,
  planPreviewPages,
  previewOut,
  reportOut,
  requestSchemaOut,
  type BrowserToolName,
} from '@sign-pdf/core/tools';
import type { SignRequestInput } from '@sign-pdf/spec';
import type { LoadedDocument } from '../app/open.ts';
import { core, type ValidationResult } from '../lib/core.ts';
import { draftFromRequest } from '../lib/draft.ts';
import { savePacketFile, saveRequestFile } from '../lib/exports.ts';
import { buildRequest, draftIssues, type PrepareAction, type PrepareState } from '../lib/fields.ts';

/** What the API reads and changes. Read at call time, so it always sees the current draft. */
export interface AgentContext {
  document(): LoadedDocument;
  state(): PrepareState;
  dispatch(action: PrepareAction): void;
  /** False once the prepare view has closed: every call then fails with `closed` and changes nothing. */
  isOpen?(): boolean;
}

export type AgentResult = Record<string, unknown>;
export type AgentTool = (input?: unknown) => Promise<AgentResult>;
export type AgentApi = Readonly<Record<BrowserToolName, AgentTool>> & {
  readonly workflow: string;
  readonly tools: readonly BrowserToolName[];
};

/** A failure this code wrote from the input; its text quotes no document. */
class UsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class InvalidRequest extends Error {
  constructor(readonly result: ValidationResult) {
    super('invalid request');
  }
}

function fail(error: unknown): AgentResult {
  if (error instanceof UsageError) return { error: { code: error.code, message: error.message } };
  // A ZodError from parseToolInput, matched by shape: zod is the core's dependency, not the app's.
  if (error instanceof Error && error.name === 'ZodError' && Array.isArray((error as { issues?: unknown }).issues)) {
    const found = (error as unknown as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    const where = found.map((issue) => `${issue.path.map(String).join('.') || 'input'}: ${issue.message}`).join('; ');
    return { error: { code: 'usage', message: `The input does not match the tool's input schema. ${where}` } };
  }
  if (error instanceof InvalidRequest) {
    return { error: { code: 'invalid-request', message: INVALID_REQUEST_MESSAGE }, validation: reportOut(error.result.report) };
  }
  const known = typeof error === 'object' && error !== null ? (error as { code?: unknown; message?: unknown; hint?: unknown }) : {};
  const code = typeof known.code === 'string' ? known.code : 'internal';
  const message = typeof known.message === 'string' ? known.message : String(error);
  // A core argument error is written by core from the arguments, so it is given plainly.
  if (code === 'invalid-argument') return { error: { code, message } };
  return {
    error: { code, message: code === 'internal' ? UNEXPECTED_MESSAGE : REJECTED_MESSAGE },
    untrusted_detail: { notice: UNTRUSTED_NOTICE, message, ...(typeof known.hint === 'string' ? { hint: known.hint } : {}) },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The page fills in what only it knows: the spec version and the open PDF's
 * name and SHA-256. A sha256 the agent gave is kept, so a request written for
 * another PDF still fails with hash-mismatch.
 */
export function withOpenDocument(request: unknown, document: Pick<LoadedDocument, 'name' | 'sha256'>): unknown {
  if (!isObject(request)) return request;
  const given = isObject(request['document']) ? request['document'] : {};
  return { version: 1, ...request, document: { name: document.name, sha256: document.sha256, ...given } };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

const CLOSED_MESSAGE =
  'The prepare view is closed, so this tool is gone. Ask the human to open the PDF in the prepare view, then use the tools of that view.';

const NOT_READY = 'The fields on the page have issues, so nothing was saved. Call get_state to read them, then fix them with apply_request.';

export function createAgentApi(ctx: AgentContext): AgentApi {
  const assertOpen = () => {
    if (ctx.isOpen && !ctx.isOpen()) throw new UsageError('closed', CLOSED_MESSAGE);
  };
  const validate = async (request: unknown): Promise<ValidationResult> => {
    const doc = ctx.document();
    return core.validateRequest(doc.bytes, withOpenDocument(request, doc));
  };
  const pageRequest = (): SignRequestInput => {
    const doc = ctx.document();
    return buildRequest(ctx.state(), { name: doc.name, sha256: doc.sha256 });
  };
  const issues = () => draftIssues(ctx.state().fields, ctx.state().signers);

  const handlers: Record<BrowserToolName, (input: Record<string, unknown>) => Promise<AgentResult>> = {
    async inspect_pdf(input) {
      const { include_text, detail, page } = input as { include_text?: boolean; detail?: 'summary' | 'full'; page?: number };
      const inspection = await core.inspectPdfWith(ctx.document().bytes, { text: include_text !== false, detail: detail ?? 'full' });
      if (page !== undefined && page > inspection.pages.length) {
        throw new UsageError('usage', `Page ${page} does not exist: the PDF has ${inspection.pages.length} page(s).`);
      }
      return inspectionOut(inspection, page);
    },
    async find_candidates(input) {
      const { max } = input as { max?: number };
      const found = await core.findCandidatesInPdf(ctx.document().bytes, max !== undefined ? { max } : {});
      return { sha256: found.sha256, page_count: found.pages.length, ...candidatesOut(found) };
    },
    async get_request_schema() {
      return { ...requestSchemaOut('page'), workflow: BROWSER_WORKFLOW };
    },
    async validate_request(input) {
      return reportOut((await validate(input['request'])).report);
    },
    async render_preview(input) {
      const { request, mark_candidates, pages, scale } = input as {
        request?: unknown;
        mark_candidates?: boolean;
        pages?: number[];
        scale?: number;
      };
      if (request === undefined && mark_candidates !== true) {
        throw new UsageError('usage', 'render_preview needs "request", or "mark_candidates": true to mark the candidates without a request.');
      }
      const bytes = ctx.document().bytes;
      let checked: ValidationResult | undefined;
      if (request !== undefined) {
        checked = await validate(request);
        if (!checked.resolved) throw new InvalidRequest(checked);
      }
      const found = mark_candidates === true ? await core.findCandidatesInPdf(bytes) : undefined;
      const plan = planPreviewPages({
        ...(checked ? { report: checked.report } : {}),
        ...(checked?.resolved ? { resolved: checked.resolved } : {}),
        ...(found ? { found } : {}),
        ...(pages ? { pages } : {}),
        ...(scale !== undefined ? { scale } : {}),
      });
      const rendered = await core.renderPreview(bytes, plan.layout, plan.options);
      const out = previewOut(rendered, { ...(checked ? { report: checked.report } : {}), ...(found ? { found } : {}), omitted: plan.omitted });
      return {
        ...out,
        how_to_read: 'pixel = origin + point * scale. Each image is a PNG, base64-encoded in "png_base64".',
        images: out.images.map((image, index) => ({ ...image, png_base64: toBase64(rendered[index]?.png ?? new Uint8Array()) })),
      };
    },
    async apply_request(input) {
      const checked = await validate(input['request']);
      if (!checked.resolved) {
        return {
          ok: false,
          applied: false,
          validation: reportOut(checked.report),
          next: 'Nothing on the page changed. Fix every error, then call apply_request again.',
        };
      }
      const action = draftFromRequest(checked.resolved);
      // The view may have closed while the request was checked.
      assertOpen();
      ctx.dispatch(action);
      const left = draftIssues(action.fields, action.signers);
      const { fields, warnings } = reportOut(checked.report);
      return {
        ok: true,
        applied: true,
        field_count: action.fields.length,
        fields,
        warnings,
        ready: left.length === 0,
        next:
          'The fields are on the page. Press "Continue to sign" to open the sign view, then stop and ask the human to review and sign, or call download_packet to save a packet for the signer. ' +
          'Only the human signs: do not operate the sign view.',
      };
    },
    async get_state() {
      const doc = ctx.document();
      const left = issues();
      const request = pageRequest();
      return {
        view: 'prepare',
        document: { sha256: doc.sha256, page_count: doc.inspection.pages.length },
        field_count: ctx.state().fields.length,
        ready: left.length === 0,
        issue_count: left.length,
        untrusted_document_content: {
          notice: UNTRUSTED_NOTICE,
          document_name: doc.name,
          request,
          issues: left.map((issue) => ({ ...(issue.fieldId !== undefined ? { field_id: issue.fieldId } : {}), message: issue.message })),
        },
      };
    },
    async download_packet() {
      if (issues().length > 0) throw new UsageError('not-ready', NOT_READY);
      const doc = ctx.document();
      const request = pageRequest();
      const saved = await savePacketFile(doc, request);
      return {
        ok: true,
        saved_to: 'downloads',
        chars: saved.chars,
        document_sha256: doc.sha256,
        field_count: request.fields.length,
        untrusted_document_content: { notice: UNTRUSTED_NOTICE, file_name: saved.name },
        next: 'Tell the human where the packet is. A signer opens it on this site to review and sign.',
      };
    },
    async download_request() {
      if (issues().length > 0) throw new UsageError('not-ready', NOT_READY);
      const request = pageRequest();
      const name = saveRequestFile(ctx.document().name, request);
      return {
        ok: true,
        saved_to: 'downloads',
        untrusted_document_content: { notice: UNTRUSTED_NOTICE, file_name: name, request },
      };
    },
  };

  const names = Object.keys(BROWSER_TOOLS) as BrowserToolName[];
  const api: Record<string, unknown> = { workflow: BROWSER_WORKFLOW, tools: Object.freeze([...names]) };
  for (const name of names) {
    api[name] = async (input?: unknown): Promise<AgentResult> => {
      try {
        assertOpen();
        return await handlers[name](parseToolInput(BROWSER_TOOLS[name], input));
      } catch (error) {
        return fail(error);
      }
    };
  }
  return Object.freeze(api) as AgentApi;
}
