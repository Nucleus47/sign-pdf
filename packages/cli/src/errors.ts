import { SignPdfError, type ValidationReport } from '@sign-pdf/core';

/** Error codes raised by the CLI layer itself. Core errors keep their own codes. */
export type CliErrorCode =
  | 'usage'
  | 'file-not-found'
  | 'file-unreadable'
  | 'file-exists'
  | 'file-too-large'
  | 'unsafe-output'
  | 'output-is-input'
  | 'output-not-allowed'
  | 'browser-unavailable'
  | 'invalid-json'
  | 'web-dir-missing'
  | 'preview-unavailable'
  | 'port-unavailable'
  | 'session-limit'
  | 'session-not-found'
  | 'cancelled'
  | 'declined'
  | 'timeout';

/** An expected failure: reported with its code and message, never with a stack trace. */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly hint?: string;

  constructor(code: CliErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

/** The request did not validate against the PDF. The report says what to fix, field by field. */
export class ValidationFailedError extends Error {
  readonly report: ValidationReport;

  constructor(report: ValidationReport) {
    const first = report.errors[0];
    super(
      `The sign request is not valid for this PDF (${report.errors.length} error(s))` +
        (first ? `: ${first.message}` : '.'),
    );
    this.name = 'ValidationFailedError';
    this.report = report;
  }

  /** The code of the first error, such as `anchor-not-found`. */
  get code(): string {
    return this.report.errors[0]?.code ?? 'invalid-request';
  }
}

export interface ErrorReport {
  /** Stable, machine-readable code. */
  code: string;
  message: string;
  fieldId?: string;
  hint?: string;
}

/** Turn anything thrown into a report. Unexpected errors get the code `internal`. */
export function describeError(error: unknown): ErrorReport {
  if (error instanceof SignPdfError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.fieldId !== undefined ? { fieldId: error.fieldId } : {}),
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    };
  }
  if (error instanceof CliError) {
    return { code: error.code, message: error.message, ...(error.hint !== undefined ? { hint: error.hint } : {}) };
  }
  if (error instanceof ValidationFailedError) {
    const first = error.report.errors[0];
    return {
      code: error.code,
      message: error.message,
      ...(first?.fieldId !== undefined ? { fieldId: first.fieldId } : {}),
      ...(first?.hint !== undefined ? { hint: first.hint } : {}),
    };
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
}

export function isExpectedError(error: unknown): boolean {
  return error instanceof SignPdfError || error instanceof CliError || error instanceof ValidationFailedError;
}
