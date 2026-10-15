import { describe, expect, it } from 'vitest';
import {
  buildErrorReport,
  failureOf,
  fileFacts,
  formatErrorReport,
  safeMessage,
  safeStack,
  type ReportContext,
} from './errorReport.ts';

const CONTEXT: ReportContext = {
  version: 'abc123def456',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) Synthetic',
  platform: 'iPhone',
  viewport: '390x664',
  devicePixelRatio: 3,
  features: { structuredClone: true, 'crypto.subtle': false },
  time: '2026-01-02T03:04:05.000Z',
  view: 'sign',
  state: 'cannot-sign',
  step: 'finish',
  file: { extension: 'pdf', bytes: 1234 },
};

describe('error report', () => {
  it('holds the code, the message, the stack frames and the browser facts', () => {
    const error = Object.assign(new Error('The PDF has no pages.'), { code: 'invalid-pdf' });
    const text = formatErrorReport(buildErrorReport(failureOf(error), CONTEXT));
    expect(text).toContain('code: invalid-pdf');
    expect(text).toContain('message: The PDF has no pages.');
    expect(text).toContain('version: abc123def456');
    expect(text).toContain(`userAgent: ${CONTEXT.userAgent}`);
    expect(text).toContain('viewport: 390x664 @3x');
    expect(text).toContain('where: view=sign state=cannot-sign step=finish');
    expect(text).toContain('file: .pdf 1234 bytes');
    expect(text).toContain('features missing: crypto.subtle');
    expect(text).toMatch(/stack:\n {2}at /);
  });

  it('keeps only the field id and the code for codes whose message names a value', () => {
    for (const code of ['value-does-not-fit', 'unsupported-characters', 'missing-required-field', 'invalid-request']) {
      expect(safeMessage({ code, fieldId: 'title', message: 'Field "title": Jane Q. Example is too long' })).toBe(`Field "title": ${code}`);
    }
    expect(safeMessage({ code: 'invalid-request', message: 'fields.0.label: Jane' })).toBe('invalid-request');
    // An id that is not a field id is not shown.
    expect(safeMessage({ code: 'value-does-not-fit', fieldId: 'Jane Example', message: 'x' })).toBe('value-does-not-fit');
  });

  it('cuts quoted text, fingerprints, data and e-mail addresses out of other messages', () => {
    expect(safeMessage({ code: 'anchor-not-found', message: 'Field "sig": the anchor text "Jane Example:" was not found.' })).toBe(
      'Field "sig": the anchor text "…" was not found.',
    );
    expect(safeMessage({ code: 'unknown', message: 'Unexpected token \'J\', “Jane” is not valid' })).not.toMatch(/Jane|'J'/);
    expect(safeMessage({ code: 'hash-mismatch', message: `expected ${'a'.repeat(64)}, got ${'Q'.repeat(64)}` })).toBe('expected [hex], got [data]');
    expect(safeMessage({ code: 'unknown', message: 'send to jane@example.invalid now' })).toBe('send to [email] now');
    expect(safeMessage({ code: 'unknown', message: "keys [x'Jane Example'] and token abcDEF123_-abcDEF123_-abcDEF123_-xy" })).toBe('keys [x"…"] and token [data]');
  });

  it('keeps stack frames only, never the message line', () => {
    const stack = [
      'Error: the value "Jane Example" does not fit',
      'second line of the message: Jane Example',
      '    at finalize (https://sign.example/assets/sign-1.js:10:20)',
      'finalize@https://sign.example/assets/sign-1.js:10:20',
      ...Array.from({ length: 30 }, (_, n) => `    at frame${n} (https://sign.example/assets/index.js:${n}:1)`),
    ].join('\n');
    const frames = safeStack(stack);
    expect(frames).toHaveLength(20);
    expect(frames[0]).toBe('at finalize (https://sign.example/assets/sign-1.js:10:20)');
    expect(frames[1]).toBe('finalize@https://sign.example/assets/sign-1.js:10:20');
    expect(frames.join('\n')).not.toContain('Jane');
  });

  it('copies only the keys it knows: extra data handed in is dropped', () => {
    const failure = {
      ...failureOf(Object.assign(new Error('x'), { code: 'invalid-pdf' })),
      request: { fields: [{ label: 'SENTINEL-LABEL', value: 'SENTINEL-VALUE' }] },
    };
    const context = { ...CONTEXT, signerName: 'SENTINEL-SIGNER', fileName: 'SENTINEL-FILE.pdf', draft: { values: { a: 'SENTINEL-VALUE' } } };
    const text = formatErrorReport(buildErrorReport(failure, context));
    expect(text).not.toMatch(/SENTINEL/);
  });

  it('describes a file by its extension and size only', () => {
    expect(fileFacts('Jane Example tax return.PDF', 4096)).toEqual({ extension: 'pdf', bytes: 4096 });
    expect(fileFacts('no extension', 10)).toEqual({ extension: '', bytes: 10 });
    const text = formatErrorReport(buildErrorReport({ code: 'x', message: 'y' }, { ...CONTEXT, file: fileFacts('Jane.signpacket.json', 9) }));
    expect(text).toContain('file: .json 9 bytes');
    expect(text).not.toContain('Jane');
  });

  it('reports the last uncaught error too', () => {
    const uncaught = failureOf(new TypeError('undefined is not a function (near "...i of e...")'), 'unhandled-rejection');
    const text = formatErrorReport(buildErrorReport({ code: 'invalid-pdf', message: 'x' }, { ...CONTEXT, uncaught }));
    expect(text).toContain('last uncaught error: unhandled-rejection: TypeError: undefined is not a function (near "…")');
  });

  it('takes the code from the error, else its name', () => {
    expect(failureOf(new TypeError('boom'))).toMatchObject({ code: 'TypeError', message: 'boom' });
    expect(failureOf(new TypeError('boom'), 'unhandled-rejection')).toMatchObject({ code: 'unhandled-rejection', message: 'TypeError: boom' });
    expect(failureOf(Object.assign(new Error('m'), { code: 'invalid-pdf' }), 'render-error').code).toBe('invalid-pdf');
    expect(failureOf('Jane Example').code).toBe('unknown');
    // A thrown string can be document text: only its type is kept.
    expect(failureOf('Jane Example').message).toBe('A value of type string was thrown.');
    expect(failureOf(Object.assign(new Error('m'), { name: 'Jane Example' })).message).toBe('m');
    expect(failureOf(Object.assign(new Error('m'), { code: 'invalid-pdf', fieldId: 'f' }))).toMatchObject({ code: 'invalid-pdf', fieldId: 'f' });
  });
});
