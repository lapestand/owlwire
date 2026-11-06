export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

export interface BucketState {
  tokens: number;
  updatedAt: Date;
}

export type TakeResult =
  | { ok: true; state: BucketState }
  | { ok: false; retryAfterMs: number; state: BucketState };

export function takeToken(spec: BucketSpec, state: BucketState, now: Date, cost = 1): TakeResult {
  const elapsedSec = Math.max(0, (now.getTime() - state.updatedAt.getTime()) / 1000);
  const tokens = Math.min(spec.capacity, state.tokens + elapsedSec * spec.refillPerSec);
  // When the clock goes backwards updatedAt stays in the future so the same interval is not refilled twice.
  const updatedAt = now.getTime() > state.updatedAt.getTime() ? now : state.updatedAt;
  if (tokens >= cost) {
    return { ok: true, state: { tokens: tokens - cost, updatedAt } };
  }
  const deficit = cost - tokens;
  const retryAfterMs =
    spec.refillPerSec > 0
      ? Math.ceil((deficit / spec.refillPerSec) * 1000)
      : Number.POSITIVE_INFINITY;
  return { ok: false, retryAfterMs, state: { tokens, updatedAt } };
}
