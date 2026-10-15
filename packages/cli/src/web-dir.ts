/** Locating the built web app and the security headers it is served with. */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.ts';

/** Equivalent to the hosted site's policy in `packages/web/public/_headers`. */
export const BUILT_IN_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; img-src 'self' blob: data:; " +
    "style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'self'; form-action 'none'",
};

/**
 * Prefer the web build shipped next to this package's `dist/` directory. Fall
 * back to the workspace build for development from `packages/cli` or `mcp`.
 */
export function defaultWebDir(): string {
  const packaged = fileURLToPath(new URL('../web/dist', import.meta.url));
  if (existsSync(join(packaged, 'index.html'))) return packaged;
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The directory to serve, checked to hold a built web app. */
export async function resolveWebDir(given?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env['SIGN_PDF_WEB_DIR'];
  const explicit = given ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined);
  const dir = resolve(explicit ?? defaultWebDir());
  if (!(await isFile(join(dir, 'index.html')))) {
    throw new CliError(
      'web-dir-missing',
      `The sign view was not found: ${join(dir, 'index.html')} does not exist.`,
      explicit === undefined
        ? 'The bundled sign view is missing. Rebuild the package (pnpm --filter @sign-pdf/web build), or pass a built web app directory with --web-dir or SIGN_PDF_WEB_DIR.'
        : 'Pass the directory that holds the built web app (the one with index.html).',
    );
  }
  return dir;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// Printable ASCII only: a header value must never carry a line break.
const HEADER_VALUE = /^[\x20-\x7e]*$/;

/** The headers of the `/*` block of a Netlify / Cloudflare Pages `_headers` file. */
export function parseHeadersFile(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let inAllPaths = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      inAllPaths = raw.trim() === '/*';
      continue;
    }
    if (!inAllPaths) continue;
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const name = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (HEADER_NAME.test(name) && HEADER_VALUE.test(value)) headers[name] = value;
  }
  return headers;
}

/**
 * Security headers for every response: the hosted site's own (`_headers` in the
 * web dir, or in the web package's `public` directory beside it), over the
 * built-in set so that no protection is lost when the file omits one.
 */
export async function loadSecurityHeaders(webDir: string): Promise<Record<string, string>> {
  const merged = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries(BUILT_IN_SECURITY_HEADERS)) merged.set(name.toLowerCase(), [name, value]);
  for (const candidate of [join(webDir, '_headers'), join(webDir, '..', 'public', '_headers')]) {
    let text: string;
    try {
      text = await readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(parseHeadersFile(text))) merged.set(name.toLowerCase(), [name, value]);
    break;
  }
  return Object.fromEntries(merged.values());
}
