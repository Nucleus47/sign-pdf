/**
 * The relay's two fixed emails. The only variable parts are validated email
 * addresses, a link the server builds, a code and a date: no sender-supplied
 * text, so the sender cannot carry spam content.
 */
import { RELAY_TTL_DAYS } from '@sign-pdf/spec';
import type { MailMessage } from './transport.ts';

export function loginCodeMessage(to: string, code: string): MailMessage {
  return {
    to,
    subject: `Your sign-pdf code: ${code}`,
    text: [
      `Your sign-pdf code is ${code}.`,
      '',
      'Enter it in sign-pdf to send a document by email. The code works for 10 minutes.',
      'If you did not ask for this code, you can ignore this email.',
    ].join('\n'),
  };
}

export function nextSignerMessage(opts: { from: string; to: string; link: string; password: boolean }): MailMessage {
  const lines = [
    `${opts.from} signed a document and asked you to sign it.`,
    '',
    `Open it: ${opts.link}`,
    '',
    `The link works for ${RELAY_TTL_DAYS} days and is private to you: anyone who has it can open the document.`,
  ];
  if (opts.password) lines.push(`You will need the password that ${opts.from} gives you.`);
  return {
    to: opts.to,
    replyTo: opts.from,
    subject: 'A document is waiting for your signature',
    text: lines.join('\n'),
  };
}

export function signedMessage(opts: {
  to: string;
  signer: string;
  link: string;
  code: string;
  deletesAt: number;
  /** True when the sender set a passphrase: the link then opens on any device (issue #105). */
  passphrase?: boolean;
}): MailMessage {
  const anyDevice = opts.passphrase === true;
  return {
    to: opts.to,
    replyTo: opts.signer,
    subject: 'Your document has been signed',
    text: [
      `${opts.signer} signed.`,
      '',
      anyDevice ? `Open it on any device: ${opts.link}` : `Open it on the device you sent it from: ${opts.link}`,
      '',
      `Your code: ${opts.code}`,
      '',
      'Enter the code to download the signed PDF; the file is then deleted.',
      ...(anyDevice ? ['On a device you did not send it from, you also need the passphrase you set.'] : []),
      `If you do nothing, it is deleted on ${formatDate(opts.deletesAt)}.`,
      anyDevice
        ? `You can also ask ${opts.signer} for the PDF; they downloaded a copy.`
        : `If that device is not available, ask ${opts.signer} for the PDF; they downloaded a copy.`,
    ].join('\n'),
  };
}

function formatDate(ms: number): string {
  const date = new Date(ms).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `${date} (UTC)`;
}
