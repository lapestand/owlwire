import { startTestDatabase, type TestDatabase } from '@owlwire/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAll } from './migrate-all.js';

let tdb: TestDatabase;
let owner: pg.Pool;

/** RLS'siz ama workspace_id kolonlu instance tabloları (R37). P2.3 workspace_suspensions ve abuse_reports ekler. */
const RLS_EXEMPT_TABLES: readonly string[] = [];

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl });
}, 120_000);

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('rls coverage', () => {
  it('every public table with a workspace_id column has RLS enabled and a <table>_tenant_isolation policy', async () => {
    const { rows } = await owner.query<{ relname: string }>(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
        and (not c.relrowsecurity
             or not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_tenant_isolation'))
      order by 1`);
    expect(rows.map((r) => r.relname).filter((t) => !RLS_EXEMPT_TABLES.includes(t))).toEqual([]);
  });

  it('workspaces, apps and catalog_types have RLS enabled', async () => {
    const { rows } = await owner.query<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity from pg_class
      where relname in ('workspaces', 'apps', 'catalog_types') and relkind = 'r' order by 1`);
    expect(rows).toEqual([
      { relname: 'apps', relrowsecurity: true },
      { relname: 'catalog_types', relrowsecurity: true },
      { relname: 'workspaces', relrowsecurity: true },
    ]);
  });

  it('does not force RLS on the table owner', async () => {
    const { rows } = await owner.query<{ n: number }>(
      "select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relforcerowsecurity",
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('owlwire_private has no SECURITY DEFINER functions (the app role may execute every function there)', async () => {
    const { rows } = await owner.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'owlwire_private' and p.prosecdef order by 1`);
    expect(rows).toEqual([]);
  });
});
