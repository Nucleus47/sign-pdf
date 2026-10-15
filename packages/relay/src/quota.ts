/**
 * Daily caps on `POST /relay/login`, the only unauthenticated path that sends
 * email. Each cap is a small JSON counter in R2 (`{count}`), keyed by the UTC
 * date and updated with a compare-and-swap on its etag. When a counter cannot
 * be updated, the caller sends no email: the caps fail closed.
 */
import { now } from './clock.ts';
import { CREATE_ONLY } from './storage.ts';

/** Login codes one address can get per UTC day. */
export const LOGIN_CODES_PER_ADDRESS_PER_DAY = 5;

/**
 * Login emails the relay sends per UTC day, for all addresses together. A bot
 * and abuse cap for the Email Service quota (3,000 messages a month included),
 * so one attack cannot spend it; real traffic is far below it.
 */
export const LOGIN_EMAILS_PER_DAY = 300;

/** Retries after a compare-and-swap that lost to another request. */
export const COUNTER_CAS_RETRIES = 3;

/** The UTC date of `ms`, as `yyyy-mm-dd`. */
export function utcDay(ms: number = now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const quotaKeys = {
  loginGlobal: (day: string) => `relay/quota/login/${day}`,
  loginAddress: (day: string, emailHash: string) => `relay/quota/login-address/${day}/${emailHash}.json`,
};

/** `counted`: under the cap, one more is counted. `capped`: the cap is reached. `failed`: no update. */
export type CounterResult = 'counted' | 'capped' | 'failed';

/**
 * Adds one to the counter at `key` unless it is at `cap`. Compare-and-swap:
 * the write succeeds only if the object is unchanged since the read (or still
 * missing), so parallel requests cannot pass the cap. A lost race is retried
 * `COUNTER_CAS_RETRIES` times; after that, on an R2 error or on a counter
 * that does not parse, the result is `failed`.
 */
export async function countUnderCap(bucket: R2Bucket, key: string, cap: number): Promise<CounterResult> {
  try {
    for (let attempt = 0; attempt <= COUNTER_CAS_RETRIES; attempt++) {
      const object = await bucket.get(key);
      let count = 0;
      if (object) {
        const value = (await object.json().catch(() => null)) as { count?: unknown } | null;
        // A counter that does not parse is a fault: fail closed.
        const stored = value?.count;
        if (typeof stored !== 'number' || !Number.isInteger(stored) || stored < 0) return 'failed';
        count = stored;
      }
      if (count >= cap) return 'capped';
      const written = await bucket.put(key, JSON.stringify({ count: count + 1 }), {
        onlyIf: object ? { etagMatches: object.etag } : CREATE_ONLY,
      });
      if (written) return 'counted';
    }
  } catch {
    // An R2 error: fall through to `failed`.
  }
  return 'failed';
}
