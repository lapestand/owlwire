import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { type SeededTenant, seedTenant } from '../__test__/seed.js';
import { SYSTEM, withSystem } from '../scope.js';
import { listDevDeliveries } from './dev-deliveries.js';

let env: DbTestEnv;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  env = await setupDbTestEnv();
  a = await seedTenant(env.db, 'dev-a');
  b = await seedTenant(env.db, 'dev-b');
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

describe('listDevDeliveries', () => {
  it('returns deliveries of every workspace joined with event, destination and connection', async () => {
    const rows = await withSystem(env.db, SYSTEM, (s) => listDevDeliveries(s, { limit: 100 }));
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([a.deliveryId, b.deliveryId]));
    const row = rows.find((r) => r.id === a.deliveryId);
    expect(row).toMatchObject({
      eventId: a.eventId,
      platform: 'telegram',
      attempts: 0,
      lastError: null,
      deliveredAt: null,
    });
    expect(typeof row?.eventType).toBe('string');
    expect(typeof row?.destinationName).toBe('string');
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('honours the limit and orders newest first', async () => {
    const rows = await withSystem(env.db, SYSTEM, (s) => listDevDeliveries(s, { limit: 1 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(b.deliveryId);
  });
});
