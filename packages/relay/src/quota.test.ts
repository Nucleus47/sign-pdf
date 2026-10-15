import { afterEach, describe, expect, it, vi } from 'vitest';
import { setClockOffsetForTests } from './clock.ts';
import { sha256Hex } from './crypto.ts';
import {
  COUNTER_CAS_RETRIES,
  LOGIN_CODES_PER_ADDRESS_PER_DAY,
  LOGIN_EMAILS_PER_DAY,
  countUnderCap,
  quotaKeys,
} from './quota.ts';
import { call, env, freshEmail, lastMailTo, outbox } from './testing.ts';

afterEach(() => {
  setClockOffsetForTests(0);
  vi.restoreAllMocks();
});

/** Moves the relay's clock to an absolute time, so each test owns its UTC day. */
function setClock(iso: string): void {
  setClockOffsetForTests(Date.parse(iso) - Date.now());
}

/** The per-email Rate Limiting binding allows 3 a minute; the caps tests need more. */
const noEmailLimit = { limit: async () => ({ success: true }) } as unknown as RateLimit;

const login = (email: string, testEnv = env) =>
  call('POST', '/relay/login', { json: { email, turnstile: 'none' }, env: testEnv });

const mailsTo = async (email: string) => (await outbox()).filter((m) => m.to === email).length;

async function counter(key: string): Promise<number | undefined> {
  const object = await env.BLOBS.get(key);
  return object ? ((await object.json()) as { count: number }).count : undefined;
}

/**
 * A bucket whose `get` of `key` returns the object and then rewrites it, so
 * the etag the caller holds is stale: a lost compare-and-swap. `conflicts`
 * says how many reads do this.
 */
function racingBucket(key: string, conflicts: number): R2Bucket {
  const real = env.BLOBS;
  let left = conflicts;
  let rewrites = 0;
  return {
    head: (k: string) => real.head(k),
    delete: (k: string | string[]) => real.delete(k),
    list: (o?: R2ListOptions) => real.list(o),
    put: (...args: Parameters<R2Bucket['put']>) => real.put(...args),
    async get(k: string, options?: R2GetOptions) {
      const object = await real.get(k, options);
      if (k === key && object && left > 0) {
        left -= 1;
        rewrites += 1;
        const value = (await (await real.get(k))!.json()) as { count: number };
        // Different bytes, so a different etag; the count stays the same.
        await real.put(k, JSON.stringify({ count: value.count, race: rewrites }));
      }
      return object;
    },
  } as unknown as R2Bucket;
}

describe('daily login caps', () => {
  it('sends no sixth code to one address in a UTC day, with the same answer', async () => {
    setClock('2031-01-10T08:00:00Z');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const email = freshEmail();
    const capsEnv = { ...env, RL_LOGIN_EMAIL: noEmailLimit };
    for (let i = 0; i < LOGIN_CODES_PER_ADDRESS_PER_DAY; i++) await login(email, capsEnv);
    expect(await mailsTo(email)).toBe(5);

    const fifthCode = /code is (\d{6})/.exec((await lastMailTo(email))?.text ?? '')?.[1];
    const sixth = await login(email, capsEnv);
    expect(sixth.status).toBe(200);
    expect(await sixth.text()).toBe('{"ok":true}');
    expect(sixth.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(await mailsTo(email)).toBe(5);
    // The capped request did not replace the code already sent.
    const verified = await call('POST', '/relay/login/verify', { json: { email, code: fifthCode } });
    expect(verified.status).toBe(200);
    expect(errors).toHaveBeenCalledWith('relay: login cap-address');
    // The log names the cap only, never the address or its hash.
    const hash = await sha256Hex(email);
    for (const [line] of errors.mock.calls) expect(String(line)).not.toMatch(new RegExp(`${email}|${hash}`));

    // The next UTC day, the address can get a code again.
    setClock('2031-01-11T00:00:01Z');
    await login(email, capsEnv);
    expect(await mailsTo(email)).toBe(6);
  });

  it('counts every login email in a global counter and stops at the cap', async () => {
    setClock('2031-02-20T12:00:00Z');
    const key = quotaKeys.loginGlobal('2031-02-20');
    await env.BLOBS.put(key, JSON.stringify({ count: LOGIN_EMAILS_PER_DAY - 2 }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const [first, second, third] = [freshEmail(), freshEmail(), freshEmail()];
    await login(first);
    expect(await counter(key)).toBe(LOGIN_EMAILS_PER_DAY - 1);
    await login(second);
    expect(await counter(key)).toBe(LOGIN_EMAILS_PER_DAY);
    const capped = await login(third);

    expect(await capped.text()).toBe('{"ok":true}');
    expect(await mailsTo(first)).toBe(1);
    expect(await mailsTo(second)).toBe(1);
    expect(await mailsTo(third)).toBe(0);
    expect(await counter(key)).toBe(LOGIN_EMAILS_PER_DAY);
    expect(errors).toHaveBeenCalledWith('relay: login cap-global');
  });

  it('keys the counters by the UTC date', async () => {
    const email = freshEmail();
    const hash = await sha256Hex(email);
    setClock('2032-06-30T23:59:58Z');
    await login(email);
    setClock('2032-07-01T00:00:01Z');
    await login(email);
    for (const day of ['2032-06-30', '2032-07-01']) {
      expect(await counter(quotaKeys.loginGlobal(day))).toBe(1);
      expect(await counter(quotaKeys.loginAddress(day, hash))).toBe(1);
    }
  });

  it('sends nothing when the counter cannot be updated', async () => {
    setClock('2031-03-05T12:00:00Z');
    const key = quotaKeys.loginGlobal('2031-03-05');
    await env.BLOBS.put(key, JSON.stringify({ count: 0 }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const email = freshEmail();
    const response = await login(email, { ...env, BLOBS: racingBucket(key, Infinity) });
    expect(await response.text()).toBe('{"ok":true}');
    expect(await mailsTo(email)).toBe(0);
    expect(errors).toHaveBeenCalledWith('relay: login cap-global-unavailable');
  });

  it('sends nothing when a counter does not parse', async () => {
    setClock('2031-03-06T12:00:00Z');
    const email = freshEmail();
    await env.BLOBS.put(quotaKeys.loginAddress('2031-03-06', await sha256Hex(email)), 'not json');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await login(email);
    expect(await response.text()).toBe('{"ok":true}');
    expect(await mailsTo(email)).toBe(0);
    expect(errors).toHaveBeenCalledWith('relay: login cap-address-unavailable');
    for (const [line] of errors.mock.calls) expect(String(line)).not.toContain(email);
  });
});

describe('countUnderCap', () => {
  it('creates a missing counter at 1', async () => {
    const key = 'relay/quota/test/create';
    expect(await countUnderCap(env.BLOBS, key, 2)).toBe('counted');
    expect(await counter(key)).toBe(1);
  });

  it('retries a lost compare-and-swap and counts once', async () => {
    const key = 'relay/quota/test/retry';
    await env.BLOBS.put(key, JSON.stringify({ count: 4 }));
    const bucket = racingBucket(key, COUNTER_CAS_RETRIES);
    expect(await countUnderCap(bucket, key, 10)).toBe('counted');
    expect(await counter(key)).toBe(5);
  });

  it('fails after the first try and every retry lose', async () => {
    const key = 'relay/quota/test/fail';
    await env.BLOBS.put(key, JSON.stringify({ count: 4 }));
    const bucket = racingBucket(key, COUNTER_CAS_RETRIES + 1);
    expect(await countUnderCap(bucket, key, 10)).toBe('failed');
    expect(await counter(key)).toBe(4);
  });

  it('fails closed on an R2 error', async () => {
    const broken = { get: async () => Promise.reject(new Error('r2 down')) } as unknown as R2Bucket;
    expect(await countUnderCap(broken, 'relay/quota/test/broken', 10)).toBe('failed');
  });

  it('lets parallel requests reach the cap and no further', async () => {
    const key = 'relay/quota/test/parallel';
    await env.BLOBS.put(key, JSON.stringify({ count: 0 }));
    const results = await Promise.all(Array.from({ length: 8 }, () => countUnderCap(env.BLOBS, key, 3)));
    const final = await counter(key);
    expect(final).toBeGreaterThanOrEqual(1);
    expect(final).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r === 'counted').length).toBe(final);
    // Then, one at a time, the counter fills to the cap and stops there.
    while ((await countUnderCap(env.BLOBS, key, 3)) === 'counted');
    expect(await counter(key)).toBe(3);
    expect(await countUnderCap(env.BLOBS, key, 3)).toBe('capped');
  });
});
