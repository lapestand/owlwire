import { describe, expect, it } from 'vitest';
import { pickLocale } from './locale.js';
import { renderMail } from './templates.js';

describe('pickLocale', () => {
  it.each([
    ['tr-TR,tr;q=0.9,en;q=0.8', 'tr'],
    ['en-US,en;q=0.9', 'en'],
    ['de-DE,tr;q=0.5', 'tr'],
    ['de-DE', 'en'],
    ['', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ])('maps %s to %s', (header, expected) => {
    expect(pickLocale(header)).toBe(expected);
  });
});

describe('renderMail', () => {
  const url = 'https://owl.example.com/api/auth/verify-email?token=abc';

  it('renders the Turkish verification email', () => {
    const m = renderMail('tr', { kind: 'verify_email', name: 'Ayşe', url });
    expect(m.subject).toBe('Owlwire e-posta adresinizi doğrulayın');
    expect(m.text).toContain('Merhaba Ayşe');
    expect(m.text).toContain(url);
    expect(m.html).toContain(`href="${url.replace(/&/g, '&amp;')}"`);
  });

  it('renders the English password reset email', () => {
    const m = renderMail('en', { kind: 'reset_password', name: 'Ali', url });
    expect(m.subject).toBe('Reset your Owlwire password');
    expect(m.text).toContain('Hi Ali');
    expect(m.text).toContain(url);
  });

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

  it('escapes html in user-controlled values', () => {
    const m = renderMail('en', { kind: 'verify_email', name: '<script>alert(1)</script>', url });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });

  it('never uses the word kanal', () => {
    for (const locale of ['tr', 'en'] as const) {
      const all = [
        renderMail(locale, { kind: 'verify_email', name: 'A', url }),
        renderMail(locale, { kind: 'reset_password', name: 'A', url }),
        renderMail(locale, {
          kind: 'invitation',
          workspaceName: 'W',
          inviterName: 'I',
          role: 'member',
          url,
          expiresAt: new Date('2026-10-19T00:00:00Z'),
        }),
      ];
      for (const m of all) expect(`${m.subject}${m.text}`.toLowerCase()).not.toContain('kanal');
    }
  });
  it('escapes the workspace and inviter names in the invitation html', () => {
    const m = renderMail('tr', {
      kind: 'invitation',
      workspaceName: '<img src=x onerror=alert(1)>',
      inviterName: '"Eve" & <b>co</b>',
      role: 'member',
      url,
      expiresAt: new Date('2026-10-19T00:00:00Z'),
    });
    expect(m.html).not.toContain('<img');
    expect(m.html).not.toContain('<b>');
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(m.html).toContain('&quot;Eve&quot; &amp; &lt;b&gt;co&lt;/b&gt;');
  });

  it('keeps line breaks in user-controlled values out of the subject and text', () => {
    const m = renderMail('en', {
      kind: 'invitation',
      workspaceName: 'Pack\r\nBcc: victim@x.test',
      inviterName: 'Mehmet\n',
      role: 'member',
      url,
      expiresAt: new Date('2026-10-19T00:00:00Z'),
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toBe('Mehmet  invited you to "Pack Bcc: victim@x.test" on Owlwire');
    expect(m.text).not.toContain('\nBcc:');
  });

  it('does not expand placeholders inside user-controlled values', () => {
    const m = renderMail('en', {
      kind: 'invitation',
      workspaceName: '{inviter} {role} {date}',
      inviterName: '{workspace}',
      role: 'admin',
      url,
      expiresAt: new Date('2026-10-19T00:00:00Z'),
    });
    expect(m.subject).toBe('{workspace} invited you to "{inviter} {role} {date}" on Owlwire');
  });

  it('renders every template in both locales with the link in text and html and no placeholder left', () => {
    for (const locale of ['tr', 'en'] as const) {
      const templates = [
        { kind: 'verify_email', name: 'A', url },
        { kind: 'reset_password', name: 'A', url },
        ...(['admin', 'member'] as const).map((role) => ({
          kind: 'invitation' as const,
          workspaceName: 'W',
          inviterName: 'I',
          role,
          url,
          expiresAt: new Date('2026-10-19T00:00:00Z'),
        })),
      ] as const;
      for (const t of templates) {
        const m = renderMail(locale, t);
        expect(m.subject).not.toBe('');
        expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/\{\w+\}/);
        expect(m.text).toContain(url);
        expect(m.html).toContain(`href="${url}"`);
        expect(m.html).toContain(`<html lang="${locale}">`);
      }
    }
  });
});
