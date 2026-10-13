import { describe, expect, it } from 'vitest';
import { computeBackoffMs, DEFAULT_MAX_ATTEMPTS } from './backoff.js';

describe('computeBackoffMs', () => {
  it('doubles from 5 seconds without jitter when rand is 0.5', () => {
    const mid = () => 0.5;
    expect(computeBackoffMs(0, mid)).toBe(5_000);
    expect(computeBackoffMs(1, mid)).toBe(10_000);
    expect(computeBackoffMs(3, mid)).toBe(40_000);
  });

  it('applies plus or minus 20 percent jitter', () => {
    expect(computeBackoffMs(1, () => 0)).toBe(8_000);
    expect(computeBackoffMs(1, () => 0.999999)).toBe(12_000);
  });

  it('caps at 30 minutes before jitter', () => {
    expect(computeBackoffMs(20, () => 0.5)).toBe(1_800_000);
    expect(computeBackoffMs(1000, () => 0)).toBe(1_440_000);
  });

  it('defaults to 8 attempts', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(8);
  });
});
