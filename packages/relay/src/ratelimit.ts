/**
 * Rate Limiting binding checks. Limits are per Cloudflare location and
 * approximate; they slow abuse down and do not replace the attempt counters.
 */
import { clientIp } from './http.ts';

export async function allowed(limiter: RateLimit, key: string): Promise<boolean> {
  const { success } = await limiter.limit({ key });
  return success;
}

export function allowedForIp(limiter: RateLimit, request: Request): Promise<boolean> {
  return allowed(limiter, `ip:${clientIp(request)}`);
}

export function allowedForEmail(limiter: RateLimit, emailHash: string): Promise<boolean> {
  return allowed(limiter, `email:${emailHash}`);
}
