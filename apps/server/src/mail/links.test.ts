import { describe, expect, it } from 'vitest';
import { canEmailLinks, InsecureLinkError, mailFailure } from './links.js';
import { MailMessageError } from './mailer.js';

describe('canEmailLinks', () => {
  it('allows https always and http only when allowed', () => {
    expect(canEmailLinks('https://owl.example', false)).toBe(true);
    expect(canEmailLinks('http://owl.example', false)).toBe(false);
    expect(canEmailLinks('http://localhost:8080', true)).toBe(true);
  });
});

describe('mailFailure', () => {
  it('names known error classes and the error code, never the message', () => {
    const insecure = mailFailure(new InsecureLinkError('https://owl.example/secret'));
    expect(insecure).toEqual({ reason: 'InsecureLinkError' });
    expect(mailFailure(new MailMessageError('to a@b.co'))).toEqual({ reason: 'MailMessageError' });
    const transport = Object.assign(new Error('auth failed for a@b.co'), { code: 'EAUTH' });
    expect(mailFailure(transport)).toEqual({ reason: 'transport', code: 'EAUTH' });
  });
});
