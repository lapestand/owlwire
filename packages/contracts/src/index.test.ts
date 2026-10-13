import { describe, expect, it } from 'vitest';
import { DevDeliveryList, EventInput, HookJsonInput, PROBLEM_CODES } from './index.js';

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
  });
});

describe('HookJsonInput', () => {
  it('requires a body and allows a title', () => {
    expect(HookJsonInput.safeParse({ title: 't', body: 'b' }).success).toBe(true);
    expect(HookJsonInput.safeParse({ title: 't' }).success).toBe(false);
  });
});

describe('DevDeliveryList', () => {
  it('parses a delivery row', () => {
    const parsed = DevDeliveryList.parse({
      deliveries: [
        {
          id: 'd',
          eventId: 'e',
          eventType: 'generic',
          eventTitle: null,
          destinationName: 'telegram:-100',
          platform: 'telegram',
          status: 'delivered',
          attempts: 1,
          lastError: null,
          createdAt: '2026-10-12T10:00:00.000Z',
          deliveredAt: '2026-10-12T10:00:01.000Z',
        },
      ],
    });
    expect(parsed.deliveries).toHaveLength(1);
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
