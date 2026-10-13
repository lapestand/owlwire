import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from './__test__/env.js';
import { createTestWorkspace } from './__test__/fixtures.js';
import { enqueueJob } from './repos/jobs.js';
import { tenantScope, withTenant } from './scope.js';

/**
 * Accepted risk (docs/security.md "Background jobs"): Graphile Worker tables have no workspace column, so RLS cannot
 * isolate them and the app role's policy is `using (true)`. Any app-role session reads every tenant's job rows;
 * workers re-check `_ws` before acting. These tests pin that state: if one fails, the risk changed (for better or
 * worse) and docs/security.md must be updated in the same change.
 */
let env: DbTestEnv;
let app: pg.Pool;
let wsA: string;
let wsB: string;
const marker = randomUUID();

beforeAll(async () => {
  env = await setupDbTestEnv();
  app = new pg.Pool({ connectionString: env.tdb.appUrl });
  wsA = await createTestWorkspace(env.db, 'gwa');
  wsB = await createTestWorkspace(env.db, 'gwb');
  await withTenant(env.db, tenantScope(wsB), (t) =>
    enqueueJob(t, 'send_delivery', { deliveryId: marker }),
  );
}, 120_000);

afterAll(async () => {
  await app?.end();
  await env?.stop();
});

describe('accepted risk: graphile worker job rows are not tenant isolated', () => {
  it('graphile_worker tables have no workspace column to isolate on', async () => {
    const { rows } = await env.owner.query<{ table: string }>(
      `select c.relname as table from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'graphile_worker' and a.attname = 'workspace_id' and not a.attisdropped`,
    );
    expect(rows).toEqual([]);
  });

  it('the app role policy on graphile_worker tables allows every row', async () => {
    const { rows } = await env.owner.query<{ table: string; qual: string; check: string }>(
      `select tablename as table, qual, with_check as check from pg_policies
        where schemaname = 'graphile_worker' and $1 = any(roles)
        order by tablename`,
      [new URL(env.tdb.appUrl).username],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ qual: 'true', check: 'true' });
  });

  it("a tenant session of workspace A reads workspace B's job row and its _ws", async () => {
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('owlwire.workspace_id', $1, true)", [wsA]);
      const { rows } = await client.query<{ ws: string }>(
        `select p.payload->>'_ws' as ws from graphile_worker._private_jobs p
          where p.payload->>'deliveryId' = $1`,
        [marker],
      );
      expect(rows).toEqual([{ ws: wsB }]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
