import pg from 'pg';

export type AppRoleMode = 'separate' | 'same';

export class AppRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppRoleError';
  }
}

// Uygulama rolünün erişebileceği şemalar. drizzle'ın migration tablosu ("drizzle" şeması) bilerek dışarıda.
const APP_SCHEMAS = ['public', 'owlwire_private', 'graphile_worker'] as const;

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
    try {
      await client.query(
        `create policy ${client.escapeIdentifier(policy)} on graphile_worker.${client.escapeIdentifier(relname)} ` +
          `for all to ${client.escapeIdentifier(appUser)} using (true) with check (true)`,
      );
    } catch (err) {
      // Advisory lock dışındaki eşzamanlı bir ensureAppRole aynı politikayı eklemiş olabilir.
      if (!isDuplicateObject(err)) throw err;
    }
  }
}

/**
 * R89: rol varsa parolaya dokunmaz, yalnız rolsuper/rolbypassrls kontrolü ve GRANT yapar;
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
            'create it with deploy/compose/initdb/10-app-role.sh or ask the database administrator',
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
    await allowGraphileWorkerTables(client, appUser);
  } finally {
    await client.end();
  }
  return 'separate';
}
