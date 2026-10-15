import { MailMessageError } from './mailer.js';
import { MailTemplateError } from './templates.js';

/** An emailed link was not built: the public URL is http in production. Carries no URL or token. */
export class InsecureLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecureLinkError';
  }
}

/**
 * Whether links under the public URL may be emailed: https always, plain http only when `allowHttp` (outside
 * production). The one rule for sign-in, reset and invitation emails, so a token never travels in clear text.
 */
export function canEmailLinks(baseURL: string, allowHttp: boolean): boolean {
  const protocol = new URL(baseURL).protocol;
  return protocol === 'https:' || (allowHttp && protocol === 'http:');
}

/** Log fields for a failed email: the error's class and code, never the link, address or message. */
export function mailFailure(err: unknown): { reason: string; code?: string } {
  const reason =
    err instanceof MailTemplateError ||
    err instanceof MailMessageError ||
    err instanceof InsecureLinkError
      ? err.name
      : 'transport';
  const code = (err as { code?: unknown } | null)?.code;
  return { reason, ...(typeof code === 'string' ? { code } : {}) };
}
