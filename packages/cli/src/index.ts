/**
 * Library surface of the CLI package, shared with the MCP server: file IO, the
 * Node preview renderer and the loopback hand-off. The validator, the candidate
 * finder and the preview constants live in core and are re-exported here.
 *
 * Nothing here signs or accepts a signature image. Only the human signs, in the
 * sign view served by the hand-off.
 */
export { AUDIT_NOTICE, readAuditRecord, summarizeAudit, type AuditCheck, type AuditSignerSummary, type AuditSummary } from './audit.ts';
export { run, EXIT_DECLINED, EXIT_ERROR, EXIT_HANDED_OFF, EXIT_OK, EXIT_TIMEOUT, type CliIo } from './cli.ts';
export {
  CliError,
  ValidationFailedError,
  describeError,
  isExpectedError,
  type CliErrorCode,
  type ErrorReport,
} from './errors.ts';
export {
  OUTPUT_FILE_MODE,
  assertWritable,
  checkOutputPath,
  defaultPacketPath,
  defaultSignedPath,
  nextFreePath,
  numberedPath,
  readJsonFile,
  readPdfFile,
  writeOutputFile,
  writeToFreePath,
  type OutputOptions,
} from './files.ts';
export {
  DEFAULT_PREVIEW_SCALE,
  FIELD_COLORS,
  MAX_PLACEMENT_CANDIDATES,
  MAX_PREVIEW_SCALE,
  MIN_PREVIEW_SCALE,
  PLACEMENT_CANDIDATE_COLOR,
  RULER_LEFT,
  RULER_TOP,
  anchorCandidatesOf,
  findCandidatesInPdf,
  nearestTextMatches,
  validateRequestAgainstPdf,
  type AnchorCandidates,
  type FieldReport,
  type NearestText,
  type PdfCandidates,
  type PreviewLayout,
  type PreviewOptions,
  type PreviewPage,
  type ValidationIssue,
  type ValidationReport,
  type ValidationResult,
} from '@sign-pdf/core';
export { openInDefaultBrowser, type BrowserOpener } from './open-browser.ts';
export { parsePageList, renderPreview } from './preview.ts';
export {
  DEFAULT_MAX_BODY_BYTES,
  MAX_BAD_NONCES,
  MAX_SESSION_TIMEOUT_MS,
  SERVED_CONTENT_TYPES,
  startSignSession,
  type SessionResult,
  type SignSession,
  type SignSessionOptions,
  type SignedDocument,
} from './session.ts';
export {
  DEFAULT_TIMEOUT_SECONDS,
  handedOffText,
  signersInTurnText,
  startSignRequest,
  type PendingSignRequest,
  type SignOutcome,
  type SignRequestOptions,
} from './sign-request.ts';
export { CLI_VERSION } from './version.ts';
export { nodeVersionError, nodeVersionHint } from './node-version.ts';
export { BUILT_IN_SECURITY_HEADERS, defaultWebDir, loadSecurityHeaders, resolveWebDir } from './web-dir.ts';
