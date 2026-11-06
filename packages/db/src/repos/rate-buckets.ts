import { type BucketSpec, takeToken } from '@owlwire/core';
import { eq } from 'drizzle-orm';
import { rateBuckets } from '../schema/index.js';
import type { SystemTx, TenantTx } from '../scope.js';
import { q } from './context.js';

/**
 * rate_buckets has no RLS (instance table). Callers pass the transaction they already hold (a tenant transaction
 * that also locks a delivery, or a system transaction); the row lock serialises concurrent takes on one scope.
 */
export async function takeBucketTokens(
  t: TenantTx | SystemTx,
  scope: string,
  spec: BucketSpec,
  now: Date,
  cost: number,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  await q(t)
    .insert(rateBuckets)
    .values({
      scope,
      tokens: spec.capacity,
      capacity: spec.capacity,
      refillPerSec: spec.refillPerSec,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const rows = await q(t)
    .select({ tokens: rateBuckets.tokens, updatedAt: rateBuckets.updatedAt })
    .from(rateBuckets)
    .where(eq(rateBuckets.scope, scope))
    .for('update');
  const row = rows[0];
  if (!row) throw new Error(`rate bucket ${scope} missing after upsert`);
  const result = takeToken(spec, { tokens: row.tokens, updatedAt: row.updatedAt }, now, cost);
  await q(t)
    .update(rateBuckets)
    .set({
      tokens: result.state.tokens,
      capacity: spec.capacity,
      refillPerSec: spec.refillPerSec,
      updatedAt: result.state.updatedAt,
    })
    .where(eq(rateBuckets.scope, scope));
  return result.ok ? { ok: true } : { ok: false, retryAfterMs: result.retryAfterMs };
}
