import type { MailLocale } from './locale.js';
import en from './messages/en.json' with { type: 'json' };
import tr from './messages/tr.json' with { type: 'json' };

export type MailTemplate =
  | { kind: 'verify_email'; name: string; url: string }
  | { kind: 'reset_password'; name: string; url: string }
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

// The catalogs share one shape; scripts/check-i18n-parity.mjs (part of `pnpm lint`) reports missing keys.
type Catalog = typeof en;
const CATALOGS: Record<MailLocale, Catalog> = { en, tr };

interface Parts {
  subject: string;
  paragraphs: string[];
  cta: string;
  url: string;
  footer: string;
}

/**
 * User-controlled values (names, workspace names) lose their control characters, so a line break cannot start a
 * new line in the subject header or the plain text part.
 */
function clean(value: string): string {
  return value.replace(/\p{Cc}+/gu, ' ');
}

/** Replaces each `{key}` in one pass, so a value that itself contains `{key}` is not expanded again. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`mail template placeholder {${key}} has no value`);
    return value;
  });
}

function formatDate(locale: MailLocale, d: Date): string {
  return new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(d);
}

function parts(locale: MailLocale, t: MailTemplate): Parts {
  const c = CATALOGS[locale];
  switch (t.kind) {
    case 'verify_email':
    case 'reset_password': {
      const m = c[t.kind];
      return {
        subject: m.subject,
        paragraphs: [fill(m.greeting, { name: clean(t.name) }), m.body],
        cta: m.cta,
        url: t.url,
        footer: m.footer,
      };
    }
    case 'invitation': {
      const m = c.invitation;
      const vars = {
        inviter: clean(t.inviterName),
        workspace: clean(t.workspaceName),
        role: m.role[t.role],
        date: formatDate(locale, t.expiresAt),
      };
      return {
        subject: fill(m.subject, vars),
        paragraphs: [m.greeting, fill(m.body, vars), fill(m.expiry, vars)],
        cta: m.cta,
        url: t.url,
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
 * HTML part.
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
