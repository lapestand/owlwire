import nodemailer from 'nodemailer';
import type { AuthEnv } from '../config/auth-env.js';

/** @public Built by the sign-up, password reset and invitation flows. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface Mailer {
  /** Rejects with MailMessageError for an invalid recipient or subject, before anything is sent. */
  send(msg: MailMessage): Promise<void>;
}
export interface MemoryMailer extends Mailer {
  outbox: MailMessage[];
}

/** A message the mailer refuses to send: not exactly one plain recipient address, or an unsafe subject. */
export class MailMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailMessageError';
  }
}

interface Transport {
  sendMail(opts: MailMessage & { from: string }): Promise<unknown>;
}
export type TransportFactory = (url: string) => Transport;

// One bare address (local@domain): no display name, no list separators, no angle brackets, quotes or whitespace.
// Anything else could make the SMTP library address the message, and its token link, to more than one recipient.
const SINGLE_ADDRESS = /^[^\s@,;<>"()[\]\\:]+@[^\s@,;<>"()[\]\\:]+$/u;
const MAX_ADDRESS_LENGTH = 254;
// Control and format characters and line or paragraph separators; a subject is one header line.
const UNSAFE_SUBJECT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Error messages name the field, never its value: the recipient is personal data. */
function assertSendable(msg: MailMessage): void {
  if (msg.to.length > MAX_ADDRESS_LENGTH || !SINGLE_ADDRESS.test(msg.to)) {
    throw new MailMessageError('mail recipient must be exactly one plain email address');
  }
  if (msg.subject.trim() === '' || UNSAFE_SUBJECT.test(msg.subject)) {
    throw new MailMessageError('mail subject must be a non-empty single line');
  }
}

/** Messages kept by the memory mailer; older ones are dropped first. */
export const MEMORY_OUTBOX_LIMIT = 100;

/**
 * For tests only. Keeps the last MEMORY_OUTBOX_LIMIT messages in `outbox`, token links included, so it must not
 * stand in for SMTP in a running server.
 */
export function createMemoryMailer(): MemoryMailer {
  const outbox: MailMessage[] = [];
  return {
    outbox,
    async send(msg) {
      assertSendable(msg);
      outbox.push({ ...msg });
      if (outbox.length > MEMORY_OUTBOX_LIMIT) {
        outbox.splice(0, outbox.length - MEMORY_OUTBOX_LIMIT);
      }
    },
  };
}

/**
 * Short limits so a dead or slow SMTP server fails a send within seconds instead of holding a sign-up or invitation
 * request for the library defaults (two minutes to connect, ten minutes of socket inactivity).
 */
export const SMTP_TIMEOUTS_MS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

/** nodemailer options for an SMTP URL; settings in the URL's query string take precedence over the timeouts. */
export function smtpTransportOptions(url: string): { url: string } & typeof SMTP_TIMEOUTS_MS {
  return { url, ...SMTP_TIMEOUTS_MS };
}

const nodemailerTransport: TransportFactory = (url) =>
  nodemailer.createTransport(smtpTransportOptions(url));

// Nothing here logs: the SMTP URL carries credentials and the messages carry sign-in links with tokens.
export function createSmtpMailer(
  url: string,
  from: string,
  createTransport: TransportFactory = nodemailerTransport,
): Mailer {
  const transport = createTransport(url);
  return {
    async send(msg) {
      assertSendable(msg);
      await transport.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
    },
  };
}

/** An SMTP mailer when SMTP is configured, otherwise null so callers can say email is unavailable. */
export function createMailerFromEnv(
  env: AuthEnv,
  createTransport?: TransportFactory,
): Mailer | null {
  // Read the fields directly: the smtp object hides its URL from JSON.stringify and inspect, not from a spread.
  return env.smtp ? createSmtpMailer(env.smtp.url, env.smtp.from, createTransport) : null;
}
