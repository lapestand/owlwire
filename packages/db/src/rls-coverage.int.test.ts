import { startTestDatabase, type TestDatabase } from '@owlwire/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authTableExemptions } from './__test__/auth-tables.js';
import { migrateAll } from './migrate-all.js';

let tdb: TestDatabase;
let owner: pg.Pool;

/** RLS'siz ama workspace_id kolonlu instance tabloları. Moderasyon tabloları (workspace_suspensions, abuse_reports) eklendiğinde buraya girer. */
const RLS_EXEMPT_TABLES: readonly string[] = [];

/**
 * Public tables with no RLS at all, each with the reason. They carry no workspace_id and no policy; any other table
 * without RLS is a finding. Keep this list deliberate: a new entry needs a reason that holds up in review.
 */
const NO_RLS_TABLES: Readonly<Record<string, string>> = {
  rate_buckets: 'instance-level pacing state keyed by scope text; only system code touches it',
  ...authTableExemptions(),
};

interface Queryable {
  query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Beklenen politika: komut ve pg_policies'in deparse ettiği qual / with_check (boşluk normalize edilir, null = yok). */
interface PolicySpec {
  cmd: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  qual: string | null;
  withCheck: string | null;
}

const tenantSpec = (column: string): PolicySpec => ({
  cmd: 'ALL',
  qual: `owlwire_private.rls_allows(${column})`,
  withCheck: `owlwire_private.rls_allows(${column})`,
});

const OWNS_APP = 'owlwire_private.rls_allows(owner_workspace_id)';
const CATALOG_WRITE =
  '(EXISTS ( SELECT 1 FROM apps a WHERE ((a.id = catalog_types.app_id) AND owlwire_private.rls_allows(a.owner_workspace_id))))';

/** Instance düzeyi tablolar: rls_allows(NULL) yalnız sistem modunda doğrudur. */
const SYSTEM_ONLY = 'owlwire_private.rls_allows(NULL::uuid)';

/** workspace_id kolonu olmayan ama RLS'li tablolar; politika kümeleri birebir beklenir. */
const SPECIAL_TABLES: Readonly<Record<string, Readonly<Record<string, PolicySpec>>>> = {
  workspaces: { workspaces_tenant_isolation: tenantSpec('id') },
  apps: {
    apps_select: {
      cmd: 'SELECT',
      qual: `(((visibility = 'public'::text) AND (approval_status = 'approved'::text)) OR ${OWNS_APP})`,
      withCheck: null,
    },
    apps_insert: { cmd: 'INSERT', qual: null, withCheck: OWNS_APP },
    apps_update: { cmd: 'UPDATE', qual: OWNS_APP, withCheck: OWNS_APP },
    apps_delete: { cmd: 'DELETE', qual: OWNS_APP, withCheck: null },
  },
  instance_settings: {
    instance_settings_system_only: {
      cmd: 'ALL',
      qual: SYSTEM_ONLY,
      withCheck: SYSTEM_ONLY,
    },
  },
  catalog_types: {
    catalog_types_select: {
      cmd: 'SELECT',
      qual: '(EXISTS ( SELECT 1 FROM apps a WHERE (a.id = catalog_types.app_id)))',
      withCheck: null,
    },
    catalog_types_write: { cmd: 'ALL', qual: CATALOG_WRITE, withCheck: CATALOG_WRITE },
  },
};

const norm = (sql: string | null): string | null =>
  sql === null ? null : sql.replace(/\s+/g, ' ').trim();

/**
 * RLS kapsam denetimi: public şemasındaki her workspace_id kolonlu tablo (relkind 'r' ve 'p'; bölümler dahil) RLS'li
 * olmalı ve politika kümesi tam olarak {<tablo>_tenant_isolation} olmalı; özel tablolar SPECIAL_TABLES'a
 * birebir uymalı. Fazladan bir politika, kısıtlayıcı (RESTRICTIVE) ya da role özel politika, değişmiş bir
 * qual/with_check hata sayılır. Bulunan sorunları döndürür (boş dizi = temiz).
 */
async function rlsCoverageProblems(db: Queryable): Promise<string[]> {
  const tables = await db.query<{ relname: string; rls: boolean; has_ws: boolean }>(`
    select c.relname, c.relrowsecurity as rls,
           exists (select 1 from pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped) as has_ws
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by 1`);
  const policies = await db.query<{
    tablename: string;
    policyname: string;
    permissive: string;
    roles: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(`select tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check
      from pg_policies where schemaname = 'public' order by 1, 2`);

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const t of tables.rows) {
    const expected =
      SPECIAL_TABLES[t.relname] ??
      (t.has_ws && !RLS_EXEMPT_TABLES.includes(t.relname)
        ? { [`${t.relname}_tenant_isolation`]: tenantSpec('workspace_id') }
        : undefined);
    if (!expected) continue;
    seen.add(t.relname);
    if (!t.rls) problems.push(`${t.relname}: row level security is not enabled`);
    const actual = policies.rows.filter((p) => p.tablename === t.relname);
    for (const name of Object.keys(expected)) {
      if (!actual.some((p) => p.policyname === name))
        problems.push(`${t.relname}: missing policy ${name}`);
    }
    for (const p of actual) {
      const spec = expected[p.policyname];
      if (!spec) {
        problems.push(
          `${t.relname}: unexpected ${p.permissive.toLowerCase()} policy ${p.policyname}`,
        );
        continue;
      }
      if (p.permissive !== 'PERMISSIVE')
        problems.push(`${t.relname}: ${p.policyname} is ${p.permissive}`);
      if (p.roles !== '{public}')
        problems.push(`${t.relname}: ${p.policyname} applies to ${p.roles}`);
      if (p.cmd !== spec.cmd)
        problems.push(`${t.relname}: ${p.policyname} cmd ${p.cmd}, expected ${spec.cmd}`);
      if (norm(p.qual) !== spec.qual)
        problems.push(`${t.relname}: ${p.policyname} qual ${JSON.stringify(p.qual)}`);
      if (norm(p.with_check) !== spec.withCheck) {
        problems.push(`${t.relname}: ${p.policyname} with_check ${JSON.stringify(p.with_check)}`);
      }
    }
  }
  for (const name of Object.keys(SPECIAL_TABLES)) {
    if (!seen.has(name)) problems.push(`${name}: table not found`);
  }
  return problems;
}

/**
 * Tables without RLS: each must be listed in NO_RLS_TABLES, have no workspace_id column and no policy; every listed
 * table must exist. Returns the problems found (empty = clean).
 */
async function noRlsTableProblems(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ relname: string; has_ws: boolean; policies: number }>(`
    select c.relname,
           exists (select 1 from pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped) as has_ws,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    order by 1`);
  const problems: string[] = [];
  for (const t of rows) {
    if (!(t.relname in NO_RLS_TABLES))
      problems.push(`${t.relname}: no RLS and not a listed exception`);
    if (t.has_ws) problems.push(`${t.relname}: has workspace_id but no RLS`);
    if (t.policies > 0) problems.push(`${t.relname}: has policies but RLS is disabled`);
  }
  for (const name of Object.keys(NO_RLS_TABLES)) {
    if (!rows.some((t) => t.relname === name))
      problems.push(`${name}: listed exception is missing or has RLS enabled`);
  }
  return problems;
}

/** Değişikliği bir transaction'da yapar, denetimi aynı bağlantıda çalıştırır, sonra geri alır. */
async function problemsAfter(
  change: string,
  check: (db: Queryable) => Promise<string[]> = rlsCoverageProblems,
): Promise<string[]> {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query(change);
    return await check(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl });
}, 120_000);

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('rls coverage', () => {
  it('every tenant table (relkind r and p) has RLS enabled and exactly the expected policies', async () => {
    expect(await rlsCoverageProblems(owner)).toEqual([]);
  });

  it('flags an extra permissive policy on a tenant table', async () => {
    expect(await problemsAfter('create policy audiences_debug on audiences using (true)')).toEqual([
      'audiences: unexpected permissive policy audiences_debug',
    ]);
  });

  it('flags a tenant policy whose expression no longer isolates', async () => {
    expect(
      await problemsAfter(
        'alter policy audiences_tenant_isolation on audiences using (true) with check (true)',
      ),
    ).toEqual([
      'audiences: audiences_tenant_isolation qual "true"',
      'audiences: audiences_tenant_isolation with_check "true"',
    ]);
  });

  it('flags an extra policy on a special table', async () => {
    expect(await problemsAfter('create policy apps_debug on apps for select using (true)')).toEqual(
      ['apps: unexpected permissive policy apps_debug'],
    );
  });

  it('flags disabled RLS', async () => {
    expect(await problemsAfter('alter table audiences disable row level security')).toEqual([
      'audiences: row level security is not enabled',
    ]);
  });

  it('flags a partitioned tenant table without a policy', async () => {
    expect(
      await problemsAfter(
        'create table rls_probe_parted (workspace_id uuid not null) partition by list (workspace_id)',
      ),
    ).toEqual([
      'rls_probe_parted: row level security is not enabled',
      'rls_probe_parted: missing policy rls_probe_parted_tenant_isolation',
    ]);
  });

  it('every table without RLS is a listed instance-level exception with no workspace_id and no policy', async () => {
    expect(await noRlsTableProblems(owner)).toEqual([]);
    for (const reason of Object.values(NO_RLS_TABLES)) expect(reason.length).toBeGreaterThan(30);
  });

  it('flags a new table without RLS, and RLS turned on for a listed exception', async () => {
    expect(
      await problemsAfter('create table rls_probe_plain (id uuid)', noRlsTableProblems),
    ).toEqual(['rls_probe_plain: no RLS and not a listed exception']);
    expect(
      await problemsAfter('alter table auth_user enable row level security', noRlsTableProblems),
    ).toEqual(['auth_user: listed exception is missing or has RLS enabled']);
  });

  it('workspaces, apps, catalog_types and instance_settings have RLS enabled', async () => {
    const { rows } = await owner.query<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity from pg_class
      where relname in ('workspaces', 'apps', 'catalog_types', 'instance_settings') and relkind = 'r'
      order by 1`);
    expect(rows).toEqual([
      { relname: 'apps', relrowsecurity: true },
      { relname: 'catalog_types', relrowsecurity: true },
      { relname: 'instance_settings', relrowsecurity: true },
      { relname: 'workspaces', relrowsecurity: true },
    ]);
  });

  it('flags an instance_settings policy that lets tenants in', async () => {
    expect(
      await problemsAfter(
        'alter policy instance_settings_system_only on instance_settings using (true) with check (true)',
      ),
    ).toEqual([
      'instance_settings: instance_settings_system_only qual "true"',
      'instance_settings: instance_settings_system_only with_check "true"',
    ]);
  });

  it('apps has the enabled approval guard trigger (before insert or update, per row)', async () => {
    const { rows } = await owner.query<{
      tgname: string;
      tgenabled: string;
      fn: string;
      def: string;
    }>(`
      select t.tgname, t.tgenabled, t.tgfoid::regproc::text as fn, pg_get_triggerdef(t.oid) as def
      from pg_trigger t where t.tgrelid = 'public.apps'::regclass and not t.tgisinternal`);
    expect(rows).toEqual([
      {
        tgname: 'apps_approval_guard',
        tgenabled: 'O',
        fn: 'owlwire_private.apps_approval_guard',
        def: 'CREATE TRIGGER apps_approval_guard BEFORE INSERT OR UPDATE ON public.apps FOR EACH ROW EXECUTE FUNCTION owlwire_private.apps_approval_guard()',
      },
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
