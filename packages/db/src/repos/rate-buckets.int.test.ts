import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import { SYSTEM, tenantScope, withSystem, withTenant } from '../scope.js';
import { takeBucketTokens } from './rate-buckets.js';

let env: DbTestEnv;

beforeAll(async () => {
  env = await setupDbTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

const spec = { capacity: 2, refillPerSec: 2 / 60 };
const t0 = new Date('2026-10-12T10:00:00Z');
const take = (scope: string, now: Date, cost = 1) =>
  withSystem(env.db, SYSTEM, (s) => takeBucketTokens(s, scope, spec, now, cost));

describe('takeBucketTokens', () => {
  it('starts full, empties and refills over time', async () => {
    expect(await take('ingest:inst:a', t0)).toEqual({ ok: true });
    expect(await take('ingest:inst:a', t0)).toEqual({ ok: true });
    expect(await take('ingest:inst:a', t0)).toEqual({ ok: false, retryAfterMs: 30_000 });
    expect(await take('ingest:inst:a', new Date(t0.getTime() + 30_000))).toEqual({ ok: true });
  });

  it('keeps buckets independent per scope', async () => {
    await take('ingest:inst:b', t0, 2);
    expect(await take('ingest:inst:c', t0)).toEqual({ ok: true });
  });

  it('serialises concurrent takes on the same scope', async () => {
    const results = await Promise.all([
      take('ingest:inst:d', t0),
      take('ingest:inst:d', t0),
      take('ingest:inst:d', t0),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it('also works inside a tenant transaction', async () => {
    const ws = await createTestWorkspace(env.db, 'alpha');
    const r = await withTenant(env.db, tenantScope(ws), (t) =>
      takeBucketTokens(t, 'ingest:inst:e', spec, t0, 1),
    );
    expect(r).toEqual({ ok: true });
  });
});
