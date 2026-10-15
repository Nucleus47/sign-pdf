/**
 * The "Technical details" a person can copy when something fails, to send to
 * whoever helps them. Pure: no DOM, no network. See ./reportContext.ts for
 * the values read from the browser.
 *
 * Privacy: the report never holds the PDF, the request, the draft, labels,
 * values, signer names, signatures, packet text or file names. Inputs are
 * flat records of primitives, and the builder copies only the keys it knows.
 * Messages are filtered, because a message can quote what it complains about.
 */

/** What a view keeps about a failure. A CoreProblem is one. */
export interface Failure {
  /** A SignPdfError code, or an app code such as "not-a-pdf". */
  code: string;
  message: string;
  stack?: string | undefined;
  fieldId?: string | undefined;
}

/** All that a report says about the file: never its name. */
export interface FileFacts {
  extension: string;
  bytes: number;
}

export interface ReportContext {
  version: string;
  userAgent: string;
  platform: string;
  viewport: string;
  devicePixelRatio: number;
  features: Readonly<Record<string, boolean>>;
  time: string;
  view?: string | undefined;
  state?: string | undefined;
  step?: string | undefined;
  pass?: string | undefined;
  file?: FileFacts | undefined;
  /** The last error that nothing caught (lib/lastError.ts). */
  uncaught?: Failure | undefined;
}

export interface ErrorReport {
  code: string;
  message: string;
  stack: string[];
  version: string;
  userAgent: string;
  platform: string;
  viewport: string;
  devicePixelRatio: number;
  features: Record<string, boolean>;
  time: string;
  view: string;
  file: string;
  uncaught: { code: string; message: string; stack: string[] } | null;
}

/** Codes whose message names a value or a label: only the field id and the code are kept. */
const FIELD_ONLY_CODES: ReadonlySet<string> = new Set([
  'value-does-not-fit',
  'unsupported-characters',
  'missing-required-field',
  'invalid-request',
]);

const MAX_FRAMES = 20;
const MAX_MESSAGE = 300;
const MAX_LINE = 240;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** A short machine word (a code, a view name), or a placeholder. */
function token(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : fallback;
}

/**
 * Quoted text, long hex strings (fingerprints) and long runs of base64 are cut
 * out of a message: they are where a value, a label, a name or file data appears.
 */
export function stripQuoted(text: string): string {
  return text
    .replace(/"[^"]*"|“[^”]*”|‘[^’]*’|«[^»]*»|`[^`]*`/g, '"…"')
    // Any pair of single quotes: an apostrophe pair ("can't … don't") is cut too, which is the safe side.
    .replace(/'[^']*'/g, '"…"')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[hex]');
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** The message as the report shows it. */
export function safeMessage(failure: Pick<Failure, 'code' | 'message' | 'fieldId'>): string {
  const code = token(failure.code);
  if (FIELD_ONLY_CODES.has(code)) {
    return typeof failure.fieldId === 'string' && SAFE_ID.test(failure.fieldId) ? `Field "${failure.fieldId}": ${code}` : code;
  }
  // A field id (the request's own identifier, never a value) is kept; all other quoted text is cut.
  const raw = String(failure.message ?? '').replace(/Field "([A-Za-z][A-Za-z0-9_-]{0,63})"/g, 'Field \u0000$1\u0000');
  const message = stripQuoted(raw)
    .replace(/Field \u0000([A-Za-z0-9_-]+)\u0000/g, 'Field "$1"')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[data]')
    .replace(/[^\s"(]+@[^\s")]+\.[^\s")]+/g, '[email]');
  return oneLine(message, MAX_MESSAGE);
}

/**
 * Stack frames only. The first line of a V8 stack repeats the message, so any
 * line that is not a frame ("at …" or "name@url:line:col") is dropped.
 */
export function safeStack(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^at\s/.test(line) || /@\S*:\d+:\d+$/.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => oneLine(stripQuoted(line), MAX_LINE));
}

/** The extension and size of a file. The name itself is never kept. */
export function fileFacts(name: string, bytes: number): FileFacts {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return { extension: match?.[1] ? match[1].toLowerCase() : '', bytes: Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0 };
}

/**
 * A Failure from anything thrown. The code is the error's own code, else
 * `fallback`, else the error's name. A name such as "TypeError" that is not
 * the code goes in front of the message.
 */
export function failureOf(error: unknown, fallback?: string): Failure {
  const candidate = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const name = typeof candidate.name === 'string' && candidate.name !== 'Error' && SAFE_TOKEN.test(candidate.name) ? candidate.name : undefined;
  const code = typeof candidate.code === 'string' ? candidate.code : (fallback ?? name ?? 'unknown');
  // A thrown string or other value can be anything, such as text from the document: only its type is kept.
  const message = typeof candidate.message === 'string' ? candidate.message : `A value of type ${typeof error} was thrown.`;
  const failure: Failure = { code, message: name && name !== code ? `${name}: ${message}` : message };
  if (typeof candidate.stack === 'string') failure.stack = candidate.stack;
  if (typeof candidate.fieldId === 'string') failure.fieldId = candidate.fieldId;
  return failure;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function plain(value: unknown, limit = MAX_LINE): string {
  return typeof value === 'string' ? oneLine(value, limit) : '';
}

export function buildErrorReport(failure: Failure, context: ReportContext): ErrorReport {
  const features: Record<string, boolean> = {};
  for (const [name, present] of Object.entries(context.features ?? {})) {
    if (SAFE_TOKEN.test(name.replace(/[ .]/g, '_'))) features[name] = present === true;
  }
  const where = [
    `view=${token(context.view, '-')}`,
    `state=${token(context.state, '-')}`,
    `step=${token(context.step, '-')}`,
    ...(context.pass === undefined ? [] : [`pass=${token(context.pass, '-')}`]),
  ].join(' ');
  const file = context.file
    ? `.${token(context.file.extension, '?')} ${finite(context.file.bytes)} bytes`
    : 'none';
  const uncaught = context.uncaught
    ? { code: token(context.uncaught.code), message: safeMessage(context.uncaught), stack: safeStack(context.uncaught.stack) }
    : null;
  return {
    code: token(failure.code),
    message: safeMessage(failure),
    stack: safeStack(failure.stack),
    version: token(context.version),
    userAgent: plain(context.userAgent, 400),
    platform: plain(context.platform, 64),
    viewport: plain(context.viewport, 32),
    devicePixelRatio: finite(context.devicePixelRatio),
    features,
    time: plain(context.time, 40),
    view: where,
    file,
    uncaught,
  };
}

const frames = (stack: readonly string[]): string[] => (stack.length > 0 ? stack.map((line) => `  ${line}`) : ['  (none)']);

export function formatErrorReport(report: ErrorReport): string {
  const missing = Object.entries(report.features).filter(([, present]) => !present).map(([name]) => name);
  const lines = [
    'sign-pdf error report',
    `code: ${report.code}`,
    `message: ${report.message}`,
    `version: ${report.version}`,
    `time: ${report.time}`,
    `where: ${report.view}`,
    `file: ${report.file}`,
    `userAgent: ${report.userAgent}`,
    `platform: ${report.platform}`,
    `viewport: ${report.viewport} @${report.devicePixelRatio}x`,
    `features missing: ${missing.length > 0 ? missing.join(', ') : 'none'}`,
    'stack:',
    ...frames(report.stack),
  ];
  if (report.uncaught) {
    lines.push(`last uncaught error: ${report.uncaught.code}: ${report.uncaught.message}`, ...frames(report.uncaught.stack));
  }
  return `${lines.join('\n')}\n`;
}
