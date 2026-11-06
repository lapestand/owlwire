import { describe, expect, it } from 'vitest';
import {
  CONNECTION_KIND_PATTERN,
  isPlatformId,
  PLATFORM_ID_PATTERN,
  SHARED_BOT_KIND,
} from './platform.js';

const VALID_PLATFORMS = [
  'telegram',
  'discord',
  'whatsapp',
  'webhook',
  'fake-a',
  'x1',
  `a${'b'.repeat(31)}`,
];
const INVALID_PLATFORMS = [
  '',
  'a',
  'Telegram',
  '1abc',
  'tele_gram',
  'tele gram',
  '-abc',
  `a${'b'.repeat(32)}`,
];
const VALID_KINDS = ['shared_bot', 'own_bot', 'webhook', 'number', 'smtp'];
const INVALID_KINDS = ['shared-bot', 'Own', '_x', ''];

describe('platform ids', () => {
  it.each(VALID_PLATFORMS)('accepts platform %s', (id) => {
    expect(isPlatformId(id)).toBe(true);
    expect(PLATFORM_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(INVALID_PLATFORMS)('rejects platform %j', (id) => {
    expect(isPlatformId(id)).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isPlatformId(42)).toBe(false);
    expect(isPlatformId(null)).toBe(false);
    expect(isPlatformId(undefined)).toBe(false);
  });

  it.each(VALID_KINDS)('accepts kind %s', (kind) => {
    expect(CONNECTION_KIND_PATTERN.test(kind)).toBe(true);
  });

  it.each(INVALID_KINDS)('rejects kind %j', (kind) => {
    expect(CONNECTION_KIND_PATTERN.test(kind)).toBe(false);
  });

  it('exposes the shared bot kind as a valid kind', () => {
    expect(SHARED_BOT_KIND).toBe('shared_bot');
    expect(CONNECTION_KIND_PATTERN.test(SHARED_BOT_KIND)).toBe(true);
  });
});
