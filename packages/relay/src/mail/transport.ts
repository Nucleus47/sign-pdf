/**
 * How the relay sends mail. `cloudflare` uses the Email Service `send_email`
 * binding; `dev-outbox` writes each message to R2 for local runs and e2e tests.
 * Transports never log: a message to the next signer holds the document key.
 */
import type { Env } from '../env.ts';
import { HttpError } from '../http.ts';
import { devOutboxTransport } from './dev-outbox.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export interface MailTransport {
  /** Throws MailError when the message was not accepted. */
  send(message: MailMessage): Promise<void>;
}

/** A failed send. `code` is the Email Service error code; it holds no message content. */
export class MailError extends Error {
  constructor(readonly code: string) {
    super(`mail failed: ${code}`);
  }
}

export const MAIL_DISPLAY_NAME = 'sign-pdf';

export function cloudflareTransport(env: Env): MailTransport {
  return {
    async send(message) {
      try {
        await env.EMAIL.send({
          from: { email: env.MAIL_FROM, name: MAIL_DISPLAY_NAME },
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        throw new MailError(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'E_UNKNOWN');
      }
    },
  };
}

export function mailTransport(env: Env): MailTransport {
  if (env.MAIL_TRANSPORT === 'cloudflare') return cloudflareTransport(env);
  if (env.MAIL_TRANSPORT === 'dev-outbox') return devOutboxTransport(env);
  throw new HttpError(500, 'server-error', 'The relay is not configured.');
}

/** Logs a mail failure by its code only. Never call this from the send handler. */
export function logMailFailure(route: string, error: unknown): void {
  const code = error instanceof MailError ? error.code : 'E_UNKNOWN';
  console.error(`relay: ${route} email-failed ${code}`);
}
