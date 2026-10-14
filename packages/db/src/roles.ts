import { PgDialect } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { APP_SCHEMAS, type RlsSubjectFlags, rlsSubjectQuery } from './rls-subject.js';

export type AppRoleMode = 'separate' | 'same';

export class AppRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppRoleError';
  }
}

interface RoleRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
}

async function readRole(client: pg.Client, name: string): Promise<RoleRow | undefined> {
  const res = await client.query<RoleRow>(
    'select rolsuper, rolbypassrls from pg_roles where rolname = $1',
    [name],
  );
  return res.rows[0];
}

const isDuplicateObject = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '42710' || code === '23505';
};

const dialect = new PgDialect();

/**
 * Rolün kendi bayrakları yetmez: sahip rolünün üyesi sahip sayılır, SUPERUSER/BYPASSRLS bir rolün üyesi
 * SET ROLE ile RLS'i aşabilir, uygulama şemalarında nesne ya da şema sahibi olan rol (doğrudan ya da üyelikle)
 * o nesnede RLS'e tabi değildir ya da nesneleri değiştirebilir. Sorgu açılış denetimiyle ortaktır (`rls-subject.ts`).
 */
async function assertSubjectToRls(client: pg.Client, appUser: string): Promise<void> {
  const query = dialect.sqlToQuery(rlsSubjectQuery(appUser));
  const { rows } = await client.query<RlsSubjectFlags>(query.sql, query.params);
  const check = rows[0];
  if (!check) throw new AppRoleError(`role ${appUser} does not exist`);
  if (check.ownerMember) {
    throw new AppRoleError(
      `role ${appUser} is a member of the owner role; the application role must be subject to row level security`,
    );
  }
  if (check.privilegedMember) {
    throw new AppRoleError(
      `role ${appUser} is a member of a SUPERUSER or BYPASSRLS role; the application role must be subject to row level security`,
    );
  }
  if (check.ownsRelation) {
    throw new AppRoleError(
      `role ${appUser} owns relations in ${APP_SCHEMAS.join(', ')}; the application role must not own tables`,
    );
  }
  if (check.ownsSchema) {
    throw new AppRoleError(
      `role ${appUser} owns schemas among ${APP_SCHEMAS.join(', ')}; the application role must not own schemas`,
    );
  }
}

/**
 * Graphile Worker kendi tablolarında RLS'i açar ama politika tanımlamaz: yalnız tablo sahibi ve BYPASSRLS
 * rolleri erişir. Uygulama rolü işleri olay kaydıyla aynı transaction'da add_job ile eklediği için (outbox)
 * her RLS'li graphile_worker tablosuna yalnız bu role açık bir politika eklenir. Graphile migration'ları
 * tabloları yeniden oluşturabilir; migrateAll bu adımı her çalıştırmada graphile migration'larından sonra yapar.
 */
async function allowGraphileWorkerTables(client: pg.Client, appUser: string): Promise<void> {
  const policy = `${appUser}_access`;
  const tables = await client.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'graphile_worker' and c.relkind = 'r' and c.relrowsecurity
       and not exists (
         select 1 from pg_policies p
         where p.schemaname = n.nspname and p.tablename = c.relname and p.policyname = $1
       )`,
    [policy],
  );
  for (const { relname } of tables.rows) {
    // Transaction içinde çalışır; çakışan bir politika transaction'ı bozmasın diye savepoint kullanılır.
    await client.query('savepoint create_policy');
    try {
      await client.query(
        `create policy ${client.escapeIdentifier(policy)} on graphile_worker.${client.escapeIdentifier(relname)} ` +
          `for all to ${client.escapeIdentifier(appUser)} using (true) with check (true)`,
      );
      await client.query('release savepoint create_policy');
    } catch (err) {
      // Advisory lock dışındaki eşzamanlı bir ensureAppRole aynı politikayı eklemiş olabilir.
      if (!isDuplicateObject(err)) throw err;
      await client.query('rollback to savepoint create_policy');
    }
  }
}

/**
 * Rol varsa parolaya dokunmaz, yalnız rolsuper/rolbypassrls kontrolü ve GRANT yapar;
 * yoksa ve sahipte CREATEROLE (ya da süper kullanıcı) varsa OWLWIRE_DATABASE_URL parolasıyla oluşturur;
 * ikisi de değilse AppRoleError. GRANT'ler her çağrıda idempotent uygulanır.
 */
export async function ensureAppRole(ownerUrl: string, appUrl: string): Promise<AppRoleMode> {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const ownerUser = decodeURIComponent(owner.username);
  const appUser = decodeURIComponent(app.username);
  const appPassword = decodeURIComponent(app.password);
  if (appUser === ownerUser) return 'same';

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const role = client.escapeIdentifier(appUser);
    let row = await readRole(client, appUser);
    if (!row) {
      const me = (
        await client.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
          'select rolsuper, rolcreaterole from pg_roles where rolname = current_user',
        )
      ).rows[0];
      if (!me?.rolsuper && !me?.rolcreaterole) {
        throw new AppRoleError(
          `role ${appUser} does not exist and ${ownerUser} cannot create roles; ` +
            'create it manually (LOGIN, NOSUPERUSER, NOBYPASSRLS, with the OWLWIRE_DATABASE_URL password) ' +
            'or grant CREATEROLE to the migration role',
        );
      }
      if (appPassword === '') {
        throw new AppRoleError(
          'OWLWIRE_DATABASE_URL must include a password to create the application role',
        );
      }
      try {
        await client.query(
          `create role ${role} with login password ${client.escapeLiteral(appPassword)} nosuperuser nobypassrls nocreatedb nocreaterole`,
        );
      } catch (err) {
        // Roller küme düzeyindedir; başka bir veritabanının migration'ı aynı anda oluşturduysa onu kullan.
        if (!isDuplicateObject(err)) throw err;
      }
      row = await readRole(client, appUser);
      if (!row) throw new AppRoleError(`role ${appUser} could not be created`);
    }
    if (row.rolsuper || row.rolbypassrls) {
      throw new AppRoleError(
        `role ${appUser} is SUPERUSER or BYPASSRLS; the application role must be subject to row level security`,
      );
    }
    await assertSubjectToRls(client, appUser);

    // GRANT'ler, migration defterinin geri alınması ve politikalar tek transaction'da: uygulama rolünün
    // graphile_worker.migrations üzerinde yetkili göründüğü bir ara durum oluşmaz.
    await client.query('begin');
    try {
      await grantAppAccess(client, appUser);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  } finally {
    await client.end();
  }
  return 'separate';
}

async function grantAppAccess(client: pg.Client, appUser: string): Promise<void> {
  const role = client.escapeIdentifier(appUser);
  const dbName = (await client.query<{ db: string }>('select current_database() as db')).rows[0]
    ?.db;
  if (!dbName) throw new AppRoleError('could not determine current database');
  await client.query(`grant connect on database ${client.escapeIdentifier(dbName)} to ${role}`);

  const present = await client.query<{ nspname: string }>(
    'select nspname from pg_namespace where nspname = any($1::text[])',
    [APP_SCHEMAS],
  );
  for (const { nspname } of present.rows) {
    const schema = client.escapeIdentifier(nspname);
    await client.query(`grant usage on schema ${schema} to ${role}`);
    await client.query(
      `grant select, insert, update, delete on all tables in schema ${schema} to ${role}`,
    );
    await client.query(`grant usage, select on all sequences in schema ${schema} to ${role}`);
    await client.query(`grant execute on all functions in schema ${schema} to ${role}`);
  }
  // audit_log is append-only for the app role, and workspace keys are never deleted by it (a
  // deleted key loses every secret of the workspace; rotation only UPDATEs them). Re-applied on every run because the
  // blanket grant above restores them. Workspace deletion still cascades: FK actions run as the table owner.
  const restricted = await client.query<{ audit: boolean; keys: boolean }>(
    "select to_regclass('public.audit_log') is not null as audit, to_regclass('public.workspace_keys') is not null as keys",
  );
  if (restricted.rows[0]?.audit) {
    await client.query(`revoke update, delete, truncate on table public.audit_log from ${role}`);
  }
  if (restricted.rows[0]?.keys) {
    await client.query(`revoke delete, truncate on table public.workspace_keys from ${role}`);
  }
  // Graphile'ın migration defteri RLS'siz; uygulama rolü onu bozamasın (yalnız _private_* tablolarına erişir).
  // Yalnız okuma kalır: worker `run()` açılışta defterden şema sürümünü okur; sürüm güncelse hiçbir şey yazmaz
  // (şemayı migrateAll sahip rolüyle önceden kurar).
  const bookkeeping = await client.query<{ present: boolean }>(
    "select to_regclass('graphile_worker.migrations') is not null as present",
  );
  if (bookkeeping.rows[0]?.present) {
    await client.query(`revoke all on table graphile_worker.migrations from ${role}`);
    await client.query(`grant select on table graphile_worker.migrations to ${role}`);
  }
  await allowGraphileWorkerTables(client, appUser);
}
