import { describe, expect, it } from 'vitest';
import { takeToken } from './limits.js';

describe('takeToken', () => {
  const spec = { capacity: 10, refillPerSec: 1 };
  const t0 = new Date('2026-10-12T10:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('takes one token from a full bucket', () => {
    const r = takeToken(spec, { tokens: 10, updatedAt: t0 }, t0);
    expect(r).toEqual({ ok: true, state: { tokens: 9, updatedAt: t0 } });
  });

  it('refills over time but never above capacity', () => {
    const r = takeToken(spec, { tokens: 0, updatedAt: t0 }, at(60_000));
    expect(r.ok).toBe(true);
    expect(r.state.tokens).toBe(9);
  });

  it('denies and reports when enough tokens will be available', () => {
    const r = takeToken(spec, { tokens: 0.5, updatedAt: t0 }, t0);
    expect(r).toEqual({ ok: false, retryAfterMs: 500, state: { tokens: 0.5, updatedAt: t0 } });
  });

  it('supports a cost larger than one', () => {
    const ok = takeToken(spec, { tokens: 10, updatedAt: t0 }, t0, 4);
    expect(ok.state.tokens).toBe(6);
    const denied = takeToken(spec, { tokens: 3, updatedAt: t0 }, t0, 5);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterMs).toBe(2000);
  });

  it('does not add tokens when the clock goes backwards', () => {
    const r = takeToken(spec, { tokens: 1, updatedAt: at(5_000) }, t0);
    expect(r.ok).toBe(true);
    expect(r.state.tokens).toBe(0);
  });

  it('never succeeds with a zero refill rate once empty', () => {
    const r = takeToken(
      { capacity: 1, refillPerSec: 0 },
      { tokens: 0, updatedAt: t0 },
      at(1_000_000),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });
});
