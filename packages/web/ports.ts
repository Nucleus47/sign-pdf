/**
 * Per-checkout port, derived from the checkout path so that several worktrees
 * on one machine never collide. Override with SIGN_PDF_WEB_PORT.
 */
import { fileURLToPath } from 'node:url';

export function derivedPort(offset = 0): number {
  const fromEnv = Number(process.env.SIGN_PDF_WEB_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv + offset;
  const here = fileURLToPath(new URL('.', import.meta.url));
  let hash = 2166136261;
  for (let i = 0; i < here.length; i += 1) {
    hash ^= here.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 20000 + ((hash >>> 0) % 20000) + offset;
}
