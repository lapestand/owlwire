import { PgDialect } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { APP_AUTH_USER_COLUMNS, AUTH_SECRET_TABLES, AUTH_TABLES } from './auth-tables.js';
import { APP_SCHEMAS, type RlsSubjectFlags, rlsSubjectQuery } from './rls-subject.js';

export type AppRoleMode = 'separate' | 'same';
/** 'none': no auth role URL was given, so no auth role was provisioned. */
export type AuthRoleMode = 'separate' | 'same' | 'none';

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
async function assertSubjectToRls(
  client: pg.Client,
  user: string,
  label = 'the application role',
): Promise<void> {
  const query = dialect.sqlToQuery(rlsSubjectQuery(user));
  const { rows } = await client.query<RlsSubjectFlags>(query.sql, query.params);
  const check = rows[0];
  if (!check) throw new AppRoleError(`role ${user} does not exist`);
  if (check.ownerMember) {
    throw new AppRoleError(
      `role ${user} is a member of the owner role; ${label} must be subject to row level security`,
    );
  }
  if (check.privilegedMember) {
    throw new AppRoleError(
      `role ${user} is a member of a SUPERUSER or BYPASSRLS role; ${label} must be subject to row level security`,
    );
  }
  if (check.ownsRelation) {
    throw new AppRoleError(
      `role ${user} owns relations in ${APP_SCHEMAS.join(', ')}; ${label} must not own tables`,
    );
  }
  if (check.ownsSchema) {
    throw new AppRoleError(
      `role ${user} owns schemas among ${APP_SCHEMAS.join(', ')}; ${label} must not own schemas`,
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

interface RoleLabels {
  /** The variable whose URL names the role and carries its password. */
  envName: string;
  /** How messages refer to the role, e.g. "the application role". */
  label: string;
}

/**
 * Creates the login role when it is missing (only when the owner may create roles, with the URL's password) and
 * refuses a role that is SUPERUSER or BYPASSRLS. An existing role's password is never changed.
 */
async function provisionLoginRole(
  client: pg.Client,
  ownerUser: string,
  user: string,
  password: string,
  labels: RoleLabels,
): Promise<void> {
  const role = client.escapeIdentifier(user);
  let row = await readRole(client, user);
  if (!row) {
    const me = (
      await client.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
        'select rolsuper, rolcreaterole from pg_roles where rolname = current_user',
      )
    ).rows[0];
    if (!me?.rolsuper && !me?.rolcreaterole) {
      throw new AppRoleError(
        `role ${user} does not exist and ${ownerUser} cannot create roles; ` +
          `create it manually (LOGIN, NOSUPERUSER, NOBYPASSRLS, with the ${labels.envName} password) ` +
          'or grant CREATEROLE to the migration role',
      );
    }
    if (password === '') {
      throw new AppRoleError(`${labels.envName} must include a password to create ${labels.label}`);
    }
    try {
      await client.query(
        `create role ${role} with login password ${client.escapeLiteral(password)} nosuperuser nobypassrls nocreatedb nocreaterole`,
      );
    } catch (err) {
      // Roller küme düzeyindedir; başka bir veritabanının migration'ı aynı anda oluşturduysa onu kullan.
      if (!isDuplicateObject(err)) throw err;
    }
    row = await readRole(client, user);
    if (!row) throw new AppRoleError(`role ${user} could not be created`);
  }
  if (row.rolsuper || row.rolbypassrls) {
    throw new AppRoleError(
      `role ${user} is SUPERUSER or BYPASSRLS; ${labels.label} must be subject to row level security`,
    );
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
    await provisionLoginRole(client, ownerUser, appUser, appPassword, {
      envName: 'OWLWIRE_DATABASE_URL',
      label: 'the application role',
    });
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
  // deleted key loses every secret of the workspace; rotation only updates them). Re-applied on every run because the
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
  await restrictAppAuthAccess(client, role);
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

/** Auth tables that exist in public, in AUTH_TABLES order. */
async function presentAuthTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `select t.name from unnest($1::text[]) with ordinality as t(name, n)
     where to_regclass('public.' || quote_ident(t.name)) is not null order by t.n`,
    [AUTH_TABLES],
  );
  return rows.map((r) => r.name);
}

/**
 * The blanket grant above covers the auth tables too; take it back. The application role gets nothing on the tables
 * that hold credentials, tokens and secrets, and only a column-limited SELECT on auth_user. Column grants from an
 * earlier run are revoked first, so a column dropped from APP_AUTH_USER_COLUMNS loses its grant.
 */
async function restrictAppAuthAccess(client: pg.Client, role: string): Promise<void> {
  const present = await presentAuthTables(client);
  for (const table of AUTH_SECRET_TABLES) {
    if (!present.includes(table)) continue;
    await client.query(`revoke all on table public.${client.escapeIdentifier(table)} from ${role}`);
  }
  if (!present.includes('auth_user')) return;
  await client.query(`revoke all on table public.auth_user from ${role}`);
  const { rows } = await client.query<{ attname: string }>(
    `select attname from pg_attribute
     where attrelid = 'public.auth_user'::regclass and attnum > 0 and not attisdropped order by attnum`,
  );
  const all = rows.map((r) => client.escapeIdentifier(r.attname)).join(', ');
  await client.query(`revoke all (${all}) on table public.auth_user from ${role}`);
  const readable = APP_AUTH_USER_COLUMNS.map((c) => client.escapeIdentifier(c)).join(', ');
  await client.query(`grant select (${readable}) on table public.auth_user to ${role}`);
}

/**
 * The auth role (owlwire_auth) is the only role the auth library connects as. It gets full DML on the auth tables,
 * INSERT on audit_log for the instance-level record of an admin grant, and what the audit_log RLS policy calls.
 * It stays subject to row level security on every tenant table and can read none of them. Like the application role
 * it must be NOSUPERUSER, NOBYPASSRLS, not a member of the owner role and not own anything; it must also be a role
 * of its own: if the application role could SET ROLE to it, the split would mean nothing.
 *
 * 'same' when the auth URL names the owner role (single-role local development; serve then refuses to start unless
 * OWLWIRE_ALLOW_INSECURE_DB_ROLE allows it). Grants are re-applied idempotently on every call.
 */
export async function ensureAuthRole(
  ownerUrl: string,
  authUrl: string,
  appUrl: string,
): Promise<'separate' | 'same'> {
  const ownerUser = decodeURIComponent(new URL(ownerUrl).username);
  const appUser = decodeURIComponent(new URL(appUrl).username);
  const auth = new URL(authUrl);
  const authUser = decodeURIComponent(auth.username);
  const authPassword = decodeURIComponent(auth.password);
  if (authUser === ownerUser) return 'same';
  if (authUser === appUser) {
    throw new AppRoleError(
      `OWLWIRE_AUTH_DATABASE_URL and OWLWIRE_DATABASE_URL both use role ${authUser}; the auth role must be a separate role`,
    );
  }

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await provisionLoginRole(client, ownerUser, authUser, authPassword, {
      envName: 'OWLWIRE_AUTH_DATABASE_URL',
      label: 'the auth role',
    });
    await assertSubjectToRls(client, authUser, 'the auth role');
    const linked = await client.query<{ appInAuth: boolean; authInApp: boolean }>(
      `select pg_has_role(a.oid, b.oid, 'MEMBER') as "appInAuth", pg_has_role(b.oid, a.oid, 'MEMBER') as "authInApp"
       from pg_roles a, pg_roles b where a.rolname = $1 and b.rolname = $2`,
      [appUser, authUser],
    );
    if (linked.rows[0]?.appInAuth || linked.rows[0]?.authInApp) {
      throw new AppRoleError(
        `roles ${appUser} and ${authUser} are members of each other; the application role must not reach the auth role`,
      );
    }
    await client.query('begin');
    try {
      await grantAuthAccess(client, authUser);
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

async function grantAuthAccess(client: pg.Client, authUser: string): Promise<void> {
  const role = client.escapeIdentifier(authUser);
  const dbName = (await client.query<{ db: string }>('select current_database() as db')).rows[0]
    ?.db;
  if (!dbName) throw new AppRoleError('could not determine current database');
  await client.query(`grant connect on database ${client.escapeIdentifier(dbName)} to ${role}`);
  await client.query(`grant usage on schema public to ${role}`);
  for (const table of await presentAuthTables(client)) {
    await client.query(
      `grant select, insert, update, delete on table public.${client.escapeIdentifier(table)} to ${role}`,
    );
  }
  const audit = await client.query<{ audit: boolean; rls: boolean }>(
    `select to_regclass('public.audit_log') is not null as audit,
       to_regprocedure('owlwire_private.rls_allows(uuid)') is not null as rls`,
  );
  if (audit.rows[0]?.audit) {
    await client.query(`grant insert on table public.audit_log to ${role}`);
  }
  if (audit.rows[0]?.rls) {
    await client.query(`grant usage on schema owlwire_private to ${role}`);
    await client.query(`grant execute on function owlwire_private.rls_allows(uuid) to ${role}`);
  }
}
