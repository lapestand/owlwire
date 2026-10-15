import { describe, expect, it } from 'vitest';
import { EventInput, HookJsonInput, PROBLEM_CODES } from './index.js';

describe('EventInput', () => {
  it('accepts a minimal event and leaves severity undefined', () => {
    const r = EventInput.parse({ type: 'player.inactive', body: 'x' });
    expect(r).toEqual({ type: 'player.inactive', body: 'x' });
  });

  it('accepts every documented field', () => {
    const r = EventInput.safeParse({
      type: 'attack.incoming',
      severity: 'high',
      title: 'Attack',
      body: '**now**',
      fields: [{ label: 'Target', value: 'Polis', inline: true }],
      url: 'https://example.com/a',
      imageUrl: 'https://example.com/a.png',
      groupKey: 'g',
      summary: 's',
      locale: 'tr',
      data: { alliance: 'X' },
      idempotencyKey: 'k-1',
    });
    expect(r.success).toBe(true);
  });

  it('rejects bad types, severities, sizes and urls', () => {
    expect(EventInput.safeParse({ type: 'Upper', body: 'x' }).success).toBe(false);
    expect(EventInput.safeParse({ type: 'a', body: 'x', severity: 'urgent' }).success).toBe(false);
    expect(EventInput.safeParse({ type: 'a', body: '' }).success).toBe(false);
    expect(EventInput.safeParse({ type: 'a', body: 'x'.repeat(8001) }).success).toBe(false);
    expect(EventInput.safeParse({ type: 'a', body: 'x', url: 'not a url' }).success).toBe(false);
    const fields = Array.from({ length: 21 }, () => ({ label: 'l', value: 'v' }));
    expect(EventInput.safeParse({ type: 'a', body: 'x', fields }).success).toBe(false);
    expect(
      EventInput.safeParse({ type: 'a', body: 'x', idempotencyKey: 'k'.repeat(129) }).success,
    ).toBe(false);
    expect(EventInput.safeParse({ type: 'a', body: 'x', idempotencyKey: '' }).success).toBe(false);
  });
});

describe('EventInput url schemes', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'ftp://example.com/a',
    'file:///etc/passwd',
  ])('rejects %s for url and imageUrl', (bad) => {
    expect(EventInput.safeParse({ type: 'a', body: 'x', url: bad }).success).toBe(false);
    expect(EventInput.safeParse({ type: 'a', body: 'x', imageUrl: bad }).success).toBe(false);
  });

  it('accepts http and https urls', () => {
    expect(EventInput.safeParse({ type: 'a', body: 'x', url: 'http://e.com/a' }).success).toBe(
      true,
    );
    expect(
      EventInput.safeParse({ type: 'a', body: 'x', imageUrl: 'https://e.com/a.png' }).success,
    ).toBe(true);
  });
});

describe('HookJsonInput', () => {
  it('requires a body and allows a title', () => {
    expect(HookJsonInput.safeParse({ title: 't', body: 'b' }).success).toBe(true);
    expect(HookJsonInput.safeParse({ title: 't' }).success).toBe(false);
  });
});

describe('PROBLEM_CODES', () => {
  it('matches the contract list', () => {
    expect(PROBLEM_CODES).toEqual([
      'unauthorized',
      'forbidden',
      'not_found',
      'validation_failed',
      'rate_limited',
      'conflict',
      'unknown_type',
      'installation_revoked',
      'payload_too_large',
      'internal',
      'unavailable',
    ]);
  });
});
