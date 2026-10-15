/** Server-side Turnstile check for `POST /relay/login`. */
import type { Env } from './env.ts';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** True when the token is valid, or when TURNSTILE_MODE is "off". */
export async function turnstileOk(env: Env, token: string, ip: string): Promise<boolean> {
  if (env.TURNSTILE_MODE === 'off') return true;
  if (!env.TURNSTILE_SECRET) {
    console.error('relay: turnstile-misconfigured');
    return false;
  }
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip !== 'unknown') form.append('remoteip', ip);
  try {
    const response = await fetch(SITEVERIFY, { method: 'POST', body: form });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
  } catch {
    return false;
  }
}
