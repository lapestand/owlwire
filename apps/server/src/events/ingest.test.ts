import { describe, expect, it } from 'vitest';
import { resolveIdempotencyKey } from './ingest.js';

describe('resolveIdempotencyKey', () => {
  it('prefers a non-blank body key, then a non-blank header key, then a fresh id', () => {
    expect(resolveIdempotencyKey('body', 'hdr')).toBe('body');
    expect(resolveIdempotencyKey(undefined, 'hdr')).toBe('hdr');
    expect(resolveIdempotencyKey('', 'hdr')).toBe('hdr');
    expect(resolveIdempotencyKey('  ', ' ')).toMatch(/^[0-9A-Za-z_-]{10,}$/);
    expect(resolveIdempotencyKey('', undefined)).not.toBe(resolveIdempotencyKey('', undefined));
  });
});
