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
  send(msg: MailMessage): Promise<void>;
}
export interface MemoryMailer extends Mailer {
  outbox: MailMessage[];
}

interface Transport {
  sendMail(opts: MailMessage & { from: string }): Promise<unknown>;
}
export type TransportFactory = (url: string) => Transport;

/** Keeps every message in `outbox`; for tests and for running without SMTP. */
export function createMemoryMailer(): MemoryMailer {
  const outbox: MailMessage[] = [];
  return {
    outbox,
    async send(msg) {
      outbox.push({ ...msg });
    },
  };
}

// Nothing here logs: the SMTP URL carries credentials and the messages carry sign-in links with tokens.
export function createSmtpMailer(
  url: string,
  from: string,
  createTransport: TransportFactory = (u) => nodemailer.createTransport(u),
): Mailer {
  const transport = createTransport(url);
  return {
    async send(msg) {
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
export function createMailerFromEnv(env: AuthEnv): Mailer | null {
  // Read the fields directly: the smtp object hides its URL from JSON.stringify and inspect, not from a spread.
  return env.smtp ? createSmtpMailer(env.smtp.url, env.smtp.from) : null;
}
