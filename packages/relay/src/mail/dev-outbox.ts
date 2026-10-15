/**
 * The dev outbox: with MAIL_TRANSPORT=dev-outbox, mail is written to R2 under
 * `relay/dev-outbox/` instead of being sent, and `GET /relay/dev/outbox` lists
 * it. Never enable this in production: the outbox shows every link and key.
 */
import { now } from '../clock.ts';
import { newDocId } from '../crypto.ts';
import type { Env } from '../env.ts';
import { keys } from '../storage.ts';
import type { MailMessage, MailTransport } from './transport.ts';

export interface OutboxEntry extends MailMessage {
  from: string;
  at: string;
}

export function devOutboxTransport(env: Env): MailTransport {
  return {
    async send(message) {
      const at = now();
      const entry: OutboxEntry = { ...message, from: env.MAIL_FROM, at: new Date(at).toISOString() };
      // Zero-padded time first, so a listing is in send order.
      const key = `${keys.outboxPrefix}${String(at).padStart(15, '0')}-${newDocId()}.json`;
      await env.BLOBS.put(key, JSON.stringify(entry));
    },
  };
}

export async function listOutbox(env: Env): Promise<OutboxEntry[]> {
  const entries: OutboxEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BLOBS.list({ prefix: keys.outboxPrefix, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      const body = await env.BLOBS.get(object.key);
      if (body) entries.push((await body.json()) as OutboxEntry);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return entries;
}
