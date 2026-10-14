import type { MailLocale } from './locale.js';
import en from './messages/en.json' with { type: 'json' };
import tr from './messages/tr.json' with { type: 'json' };

export type MailTemplate =
  | { kind: 'verify_email'; name: string; url: string }
  | {
      kind: 'reset_password';
      name: string;
      url: string;
      /** How long the reset link stays valid, as configured for the auth library. */
      expiresInSeconds: number;
    }
  | {
      kind: 'invitation';
      workspaceName: string;
      inviterName: string;
      role: 'admin' | 'member';
      url: string;
      expiresAt: Date;
    };

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/** Input that cannot be rendered safely: a link that is not an absolute http(s) URL, or an invalid value. */
export class MailTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailTemplateError';
  }
}

// The catalogs share one shape; scripts/check-i18n-parity.mjs (part of `pnpm lint`) checks keys and placeholders.
type Catalog = typeof en;
const CATALOGS: Record<MailLocale, Catalog> = { en, tr };

/** Longest name, inviter name or workspace name shown, in characters; longer values are cut with an ellipsis. */
export const MAX_DISPLAY_NAME_LENGTH = 80;

interface Parts {
  subject: string;
  paragraphs: string[];
  cta: string;
  url: string;
  footer: string;
}

// Control and format characters (bidi overrides and isolates, zero-width marks) and line or paragraph separators.
// They could break a header line or make a name read differently from what it is.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/**
 * Display form of a user-controlled value (name, inviter, workspace): unsafe characters become spaces, whitespace
 * is collapsed and trimmed, and the result is cut to MAX_DISPLAY_NAME_LENGTH characters. May return ''.
 */
function clean(value: string): string {
  const chars = Array.from(value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim());
  if (chars.length <= MAX_DISPLAY_NAME_LENGTH) return chars.join('');
  return `${chars
    .slice(0, MAX_DISPLAY_NAME_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}

/** The link as given, once it is an absolute http(s) URL without whitespace or control characters. */
function safeUrl(url: string): string {
  if (/[\s\p{Cc}\p{Cf}]/u.test(url)) {
    throw new MailTemplateError('mail link contains whitespace or control characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MailTemplateError('mail link is not an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MailTemplateError('mail link must use http or https');
  }
  return url;
}

/** Replaces each `{key}` in one pass, so a value that itself contains `{key}` is not expanded again. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`mail template placeholder {${key}} has no value`);
    return value;
  });
}

/**
 * Expiry moments are shown with date, time and an explicit "UTC" in the recipient's language. Recipients live in
 * any time zone and the server does not know theirs, so one stated zone is clearer than a guessed local one.
 */
function formatMoment(locale: MailLocale, d: Date): string {
  return new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(d);
}

/** Whole hours when the lifetime is a multiple of an hour, otherwise minutes rounded up. */
function formatDuration(locale: MailLocale, seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new MailTemplateError('link lifetime must be a positive number of seconds');
  }
  const inHours = seconds % 3600 === 0;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: inHours ? 'hour' : 'minute',
    unitDisplay: 'long',
  }).format(inHours ? seconds / 3600 : Math.ceil(seconds / 60));
}

function parts(locale: MailLocale, t: MailTemplate): Parts {
  const c = CATALOGS[locale];
  const url = safeUrl(t.url);
  switch (t.kind) {
    case 'verify_email':
    case 'reset_password': {
      const m = c[t.kind];
      const name = clean(t.name);
      const paragraphs = [name ? fill(m.greeting, { name }) : m.greeting_neutral, m.body];
      if (t.kind === 'reset_password') {
        paragraphs.push(
          fill(c.reset_password.expiry, { duration: formatDuration(locale, t.expiresInSeconds) }),
        );
      }
      return { subject: m.subject, paragraphs, cta: m.cta, url, footer: m.footer };
    }
    case 'invitation': {
      const m = c.invitation;
      const workspace = clean(t.workspaceName);
      if (!workspace) throw new MailTemplateError('invitation needs a workspace name');
      if (Number.isNaN(t.expiresAt.getTime()))
        throw new MailTemplateError('invalid invitation expiry');
      const inviter = clean(t.inviterName);
      const vars = {
        inviter,
        workspace,
        role: m.role[t.role],
        date: formatMoment(locale, t.expiresAt),
      };
      return {
        subject: fill(inviter ? m.subject : m.subject_neutral, vars),
        paragraphs: [
          m.greeting,
          fill(inviter ? m.body : m.body_neutral, vars),
          fill(m.expiry, vars),
        ],
        cta: m.cta,
        url,
        footer: m.footer,
      };
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The result holds a link with a one-time token: send it, never log it. Every interpolated value is escaped in the
 * HTML part. Throws MailTemplateError for a link that is not an absolute http(s) URL.
 */
export function renderMail(locale: MailLocale, t: MailTemplate): RenderedMail {
  const p = parts(locale, t);
  const text = [...p.paragraphs, `${p.cta}: ${p.url}`, p.footer].join('\n\n');
  const html =
    `<!doctype html><html lang="${locale}"><body style="font-family:sans-serif;line-height:1.5">` +
    p.paragraphs.map((x) => `<p>${escapeHtml(x)}</p>`).join('') +
    `<p><a href="${escapeHtml(p.url)}">${escapeHtml(p.cta)}</a></p>` +
    `<p style="color:#666">${escapeHtml(p.footer)}</p>` +
    '</body></html>';
  return { subject: p.subject, text, html };
}
