import { describe, expect, it } from 'vitest';
import { FakeClock, systemClock } from './clock.js';

describe('FakeClock', () => {
  it('starts at the given instant, advances and can be set', () => {
    const clock = new FakeClock(new Date('2026-10-12T10:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-10-12T10:00:00.000Z');
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-10-12T10:00:01.500Z');
    clock.set(new Date('2027-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('returns a fresh Date each call so callers cannot mutate the clock', () => {
    const clock = new FakeClock(new Date('2026-10-12T10:00:00.000Z'));
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

describe('systemClock', () => {
  it('returns a Date', () => {
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});
