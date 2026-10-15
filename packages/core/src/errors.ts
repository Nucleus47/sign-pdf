export type SignPdfErrorCode =
  | 'invalid-request'
  | 'invalid-pdf'
  | 'encrypted-pdf'
  | 'hash-mismatch'
  | 'anchor-not-found'
  | 'acro-field-not-found'
  | 'page-out-of-range'
  | 'field-out-of-bounds'
  | 'invalid-packet'
  | 'invalid-handoff'
  | 'missing-required-field'
  | 'value-does-not-fit'
  | 'unsupported-characters'
  | 'not-signed'
  /** A caller passed an option out of range, such as a preview scale or a candidate limit. */
  | 'invalid-argument';

export class SignPdfError extends Error {
  readonly code: SignPdfErrorCode;
  /** The field the error refers to, when there is one. */
  readonly fieldId?: string;
  /** What the caller can change to fix the error, when applicable. */
  readonly hint?: string;

  constructor(code: SignPdfErrorCode, message: string, fieldId?: string, hint?: string) {
    super(message);
    this.name = 'SignPdfError';
    this.code = code;
    if (fieldId !== undefined) this.fieldId = fieldId;
    if (hint !== undefined) this.hint = hint;
  }
}

interface IssueLike {
  path: PropertyKey[];
  message: string;
}

/** One readable entry per schema issue, such as `fields.0.id: duplicate field id "a"`. */
export function formatIssues(issues: readonly IssueLike[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
