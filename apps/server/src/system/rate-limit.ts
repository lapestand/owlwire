import type { BucketSpec, EditionConfig } from '@owlwire/core';
import { takeBucketTokens } from '@owlwire/db';
import { SYSTEM, withSystem } from '@owlwire/db/system';
import type { Deps } from '../deps.js';
import { ProblemError } from '../errors.js';

/** Bucket scopes in rate_buckets for ingest: one per installation token, one per app key. */
export const ingestKeys = {
  installation: (id: string) => `ingest:inst:${id}`,
  app: (id: string) => `ingest:app:${id}`,
};

/** Capacity is the per-minute limit and it refills evenly over a minute; a limit of zero or below turns it off. */
function ingestBucketSpec(edition: EditionConfig): BucketSpec | null {
  const perMinute = edition.ingest.ratePerMinutePerToken;
  if (!perMinute || perMinute <= 0) return null;
  return { capacity: perMinute, refillPerSec: perMinute / 60 };
}

/**
 * Takes exactly `cost` tokens from the bucket in a short system transaction of its own, so the bucket row lock is
 * released before the caller writes anything. A cost the bucket can never hold is the caller's to refuse first
 * (see consumeIngestBatchRemainder); here it only waits.
 */
export async function takeRateBudget(
  deps: Pick<Deps, 'db' | 'clock'>,
  key: string,
  spec: BucketSpec,
  cost: number,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  if (cost <= 0) return { ok: true };
  const now = deps.clock.now();
  const result = await withSystem(deps.db, SYSTEM, (s) =>
    takeBucketTokens(s, key, spec, now, cost),
  );
  return result.ok
    ? { ok: true }
    : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)) };
}

/** Ingest budget for one token: throws 429 rate_limited with Retry-After (seconds) when it is spent. */
export async function consumeIngestBudget(
  deps: Pick<Deps, 'db' | 'clock' | 'config'>,
  key: string,
  cost: number,
): Promise<void> {
  const spec = ingestBucketSpec(deps.config.edition);
  if (!spec) return;
  const result = await takeRateBudget(deps, key, spec, cost);
  if (!result.ok) {
    throw new ProblemError(
      429,
      'rate_limited',
      `ingest limit of ${spec.capacity} events per minute exceeded`,
      { 'Retry-After': String(result.retryAfterSeconds) },
    );
  }
}

export const BATCH_OVER_RATE_LIMIT_DETAIL = 'batch exceeds the per-minute rate limit';

/**
 * The handler's part of a batch of `batchSize` events, after ingestRateLimit took one token for the request: takes
 * the remaining `batchSize - 1`. A batch larger than the bucket capacity could never pass, however long the client
 * waits, so it is refused with 422 and the request's token is given back: retrying it never drains the budget.
 */
export async function consumeIngestBatchRemainder(
  deps: Pick<Deps, 'db' | 'clock' | 'config'>,
  key: string,
  batchSize: number,
): Promise<void> {
  const spec = ingestBucketSpec(deps.config.edition);
  if (!spec) return;
  if (batchSize > spec.capacity) {
    const now = deps.clock.now();
    // A negative take returns the token; a refund above capacity is capped on the next take.
    await withSystem(deps.db, SYSTEM, (s) => takeBucketTokens(s, key, spec, now, -1));
    throw new ProblemError(422, 'validation_failed', BATCH_OVER_RATE_LIMIT_DETAIL);
  }
  await consumeIngestBudget(deps, key, batchSize - 1);
}

/**
 * Public invitation endpoints (lookup without a session, accept with one): requests per client address. Fixed, not
 * configurable: invitation tokens are 256-bit, so the limit only bounds database load from guessing.
 */
export const INVITATION_RATE_PER_MINUTE = 20;
export const invitationKeys = { ip: (address: string) => `invite:ip:${address}` };
export const INVITATION_BUCKET: BucketSpec = {
  capacity: INVITATION_RATE_PER_MINUTE,
  refillPerSec: INVITATION_RATE_PER_MINUTE / 60,
};
