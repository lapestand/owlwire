import { describe, expect, it } from 'vitest';
import { pickLocale } from './locale.js';
import {
  MAX_DISPLAY_NAME_LENGTH,
  type MailTemplate,
  MailTemplateError,
  renderMail,
} from './templates.js';

describe('pickLocale', () => {
  it.each([
    ['tr-TR,tr;q=0.9,en;q=0.8', 'tr'],
    ['en-US,en;q=0.9', 'en'],
    ['de-DE,tr;q=0.5', 'tr'],
    ['de-DE', 'en'],
    ['', 'en'],
    [null, 'en'],
    [undefined, 'en'],
    ['en;q=0.1,tr;q=0.9', 'tr'],
    ['tr;q=0,en', 'en'],
    ['tr;q=0', 'en'],
    ['tr;q=0.000,en;q=0.001', 'en'],
    ['de, tr;q=0.5, en;q=0.5', 'tr'],
    ['de, en;q=0.5, tr;q=0.5', 'en'],
    ['tr;q=abc,en;q=0.2', 'en'],
    ['  TR  ', 'tr'],
    ['tr_TR', 'tr'],
    ['en_US', 'en'],
    ['*', 'en'],
    ['*;q=1,tr;q=0.8', 'tr'],
    [',,;q=1,', 'en'],
  ])('maps %s to %s', (header, expected) => {
    expect(pickLocale(header)).toBe(expected);
  });
});

describe('renderMail', () => {
  const url = 'https://owl.example.com/api/auth/verify-email?token=abc';
  const expiresAt = new Date('2026-10-19T12:00:00Z');
  const invitation = (over: Partial<Extract<MailTemplate, { kind: 'invitation' }>> = {}) =>
    ({
      kind: 'invitation',
      workspaceName: 'W',
      inviterName: 'I',
      role: 'member',
      url,
      expiresAt,
      ...over,
    }) as const;

  it('renders the Turkish verification email', () => {
    const m = renderMail('tr', { kind: 'verify_email', name: 'Ayşe', url });
    expect(m.subject).toBe('Owlwire e-posta adresinizi doğrulayın');
    expect(m.text).toContain('Merhaba Ayşe');
    expect(m.text).toContain(url);
    expect(m.html).toContain(`href="${url.replace(/&/g, '&amp;')}"`);
  });

  it('renders the English password reset email', () => {
    const m = renderMail('en', {
      kind: 'reset_password',
      name: 'Ali',
      url,
      expiresInSeconds: 3600,
    });
    expect(m.subject).toBe('Reset your Owlwire password');
    expect(m.text).toContain('Hi Ali');
    expect(m.text).toContain(url);
  });

  it.each([
    ['en', 3600, 'The link is valid for 1 hour.'],
    ['en', 7200, 'The link is valid for 2 hours.'],
    ['en', 900, 'The link is valid for 15 minutes.'],
    ['en', 61, 'The link is valid for 2 minutes.'],
    ['tr', 3600, 'Bağlantı 1 saat boyunca geçerlidir.'],
    ['tr', 1800, 'Bağlantı 30 dakika boyunca geçerlidir.'],
  ] as const)('states the reset link lifetime (%s, %i s)', (locale, seconds, sentence) => {
    const m = renderMail(locale, {
      kind: 'reset_password',
      name: 'A',
      url,
      expiresInSeconds: seconds,
    });
    expect(m.text).toContain(sentence);
    expect(m.html).toContain(`<p>${sentence}</p>`);
  });

  it.each([0, -60, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a reset link lifetime of %s',
    (seconds) => {
      expect(() =>
        renderMail('en', { kind: 'reset_password', name: 'A', url, expiresInSeconds: seconds }),
      ).toThrow(MailTemplateError);
    },
  );

  it('renders the invitation with translated role and expiry date', () => {
    const m = renderMail('tr', {
      kind: 'invitation',
      workspaceName: 'Kurt Sürüsü',
      inviterName: 'Mehmet',
      role: 'admin',
      url: 'https://owl.example.com/invite/ow_inv_x',
      expiresAt: new Date('2026-10-19T12:00:00Z'),
    });
    expect(m.subject).toBe('Mehmet sizi Owlwire\'da "Kurt Sürüsü" workspace\'ine davet etti');
    expect(m.text).toContain('yönetici');
    expect(m.text).toContain('19 Ekim 2026');
    const en = renderMail('en', {
      kind: 'invitation',
      workspaceName: 'Wolf Pack',
      inviterName: 'Mehmet',
      role: 'member',
      url: 'https://owl.example.com/invite/ow_inv_x',
      expiresAt: new Date('2026-10-19T12:00:00Z'),
    });
    expect(en.subject).toBe('Mehmet invited you to "Wolf Pack" on Owlwire');
    expect(en.text).toContain('as a member');
    expect(en.text).toContain('October 19, 2026');
  });

  it('shows the invitation expiry with time and an explicit UTC zone', () => {
    const late = new Date('2026-10-19T22:30:00Z');
    expect(renderMail('en', invitation({ expiresAt: late })).text).toContain(
      'The invitation is valid until October 19, 2026 at 22:30 UTC.',
    );
    expect(renderMail('tr', invitation({ expiresAt: late })).text).toContain(
      'Davet 19 Ekim 2026 22:30 UTC tarihine kadar geçerlidir.',
    );
  });

  it('rejects an invalid invitation expiry', () => {
    expect(() => renderMail('en', invitation({ expiresAt: new Date('nope') }))).toThrow(
      MailTemplateError,
    );
  });

  it('escapes html in user-controlled values', () => {
    const m = renderMail('en', { kind: 'verify_email', name: '<script>alert(1)</script>', url });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });

  it('escapes the workspace and inviter names in the invitation html', () => {
    const m = renderMail(
      'tr',
      invitation({
        workspaceName: '<img src=x onerror=alert(1)>',
        inviterName: '"Eve" & <b>co</b>',
      }),
    );
    expect(m.html).not.toContain('<img');
    expect(m.html).not.toContain('<b>');
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(m.html).toContain('&quot;Eve&quot; &amp; &lt;b&gt;co&lt;/b&gt;');
  });

  it('escapes &, quotes and angle brackets in the link href', () => {
    const tricky = "https://x.test/a?token=t&next=\"><script>x</script>&q='1'";
    const m = renderMail('en', { kind: 'verify_email', name: 'A', url: tricky });
    expect(m.html).toContain(
      'href="https://x.test/a?token=t&amp;next=&quot;&gt;&lt;script&gt;x&lt;/script&gt;&amp;q=&#39;1&#39;"',
    );
    expect(m.html).not.toContain('"><script>');
    expect(m.html).not.toContain('<script>');
    expect(m.text).toContain(tricky);
  });

  it('keeps an & in a realistic auth link escaped exactly once', () => {
    const link = 'https://owl.example.com/api/auth/verify-email?token=abc&callbackURL=%2Fapp';
    const m = renderMail('en', { kind: 'verify_email', name: 'A', url: link });
    expect(m.html).toContain(
      'href="https://owl.example.com/api/auth/verify-email?token=abc&amp;callbackURL=%2Fapp"',
    );
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'mailto:a@x.test',
    'ftp://x.test/file',
    '/relative/path?token=abc',
    'owl.example.com/verify',
    '',
    'https://x.test/a\nBcc: v@x.test',
    'https://x.test/a b',
    ' https://x.test/a',
    'https://x.test/\u202Eexe',
  ])('rejects the link %j', (bad) => {
    expect(() => renderMail('en', { kind: 'verify_email', name: 'A', url: bad })).toThrow(
      MailTemplateError,
    );
  });

  it('accepts plain http links (local installs without TLS)', () => {
    expect(
      renderMail('en', { kind: 'verify_email', name: 'A', url: 'http://localhost:8080/x' }).text,
    ).toContain('http://localhost:8080/x');
  });

  it('keeps line breaks in user-controlled values out of the subject and text', () => {
    const m = renderMail(
      'en',
      invitation({ workspaceName: 'Pack\r\nBcc: victim@x.test', inviterName: 'Mehmet\n' }),
    );
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toBe('Mehmet invited you to "Pack Bcc: victim@x.test" on Owlwire');
    expect(m.text).not.toContain('\nBcc:');
  });

  it('strips bidi controls and line or paragraph separators from names', () => {
    const m = renderMail(
      'en',
      invitation({
        workspaceName: 'Pack\u2028\u2029Two',
        inviterName: 'Eve\u202Egnp.exe\u2066x\u2069\u200B',
      }),
    );
    expect(m.subject).toBe('Eve gnp.exe x invited you to "Pack Two" on Owlwire');
    expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/[\u2028\u2029\u202E\u2066\u2069\u200B]/);
  });

  it('caps long names', () => {
    const m = renderMail(
      'en',
      invitation({ workspaceName: 'w'.repeat(500), inviterName: '😀'.repeat(200) }),
    );
    const capped = (c: string) => `${c.repeat(MAX_DISPLAY_NAME_LENGTH - 1)}…`;
    expect(m.subject).toBe(`${capped('😀')} invited you to "${capped('w')}" on Owlwire`);
    const v = renderMail('en', { kind: 'verify_email', name: 'n'.repeat(500), url });
    expect(v.text).toContain(`Hi ${capped('n')},`);
  });

  it('uses a neutral greeting when the name is empty after cleaning', () => {
    for (const name of ['', '   ', '\n\u202E']) {
      expect(renderMail('en', { kind: 'verify_email', name, url }).text.startsWith('Hi,\n')).toBe(
        true,
      );
      expect(
        renderMail('tr', { kind: 'reset_password', name, url, expiresInSeconds: 3600 }).text,
      ).toMatch(/^Merhaba,\n/);
    }
  });

  it('words the invitation without an inviter when the inviter name is empty', () => {
    const en = renderMail('en', invitation({ inviterName: ' ', workspaceName: 'Pack' }));
    expect(en.subject).toBe('You were invited to "Pack" on Owlwire');
    expect(en.text).toContain('You were invited to the "Pack" workspace on Owlwire as a member.');
    const tr = renderMail('tr', invitation({ inviterName: '', workspaceName: 'Sürü' }));
    expect(tr.subject).toBe('Owlwire\'da "Sürü" workspace\'ine davet edildiniz');
    expect(tr.text).toContain('Owlwire\'daki "Sürü" workspace\'ine üye olarak davet edildiniz.');
  });

  it('rejects an invitation without a workspace name', () => {
    expect(() => renderMail('en', invitation({ workspaceName: '\n ' }))).toThrow(MailTemplateError);
  });

  it('does not expand placeholders inside user-controlled values', () => {
    const m = renderMail(
      'en',
      invitation({
        workspaceName: '{inviter} {role} {date}',
        inviterName: '{workspace}',
        role: 'admin',
      }),
    );
    expect(m.subject).toBe('{workspace} invited you to "{inviter} {role} {date}" on Owlwire');
  });

  const allTemplates = (): MailTemplate[] => [
    { kind: 'verify_email', name: 'A', url },
    { kind: 'verify_email', name: '', url },
    { kind: 'reset_password', name: 'A', url, expiresInSeconds: 3600 },
    { kind: 'reset_password', name: '', url, expiresInSeconds: 900 },
    invitation({ role: 'admin' }),
    invitation({ role: 'member' }),
    invitation({ inviterName: '' }),
  ];

  it('renders every template in both locales with the link in text and html and no placeholder left', () => {
    for (const locale of ['tr', 'en'] as const) {
      for (const t of allTemplates()) {
        const m = renderMail(locale, t);
        expect(m.subject).not.toBe('');
        expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/\{\w+\}/);
        expect(m.text).toContain(url);
        expect(m.html).toContain(`href="${url}"`);
        expect(m.html).toContain(`<html lang="${locale}">`);
      }
    }
  });

  it('never uses the word kanal', () => {
    for (const locale of ['tr', 'en'] as const) {
      for (const t of allTemplates()) {
        const m = renderMail(locale, t);
        expect(`${m.subject}${m.text}${m.html}`.toLowerCase()).not.toContain('kanal');
      }
    }
  });
});
