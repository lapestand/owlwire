import { DecryptError, type Keyring, unwrapWorkspaceDek } from '@owlwire/crypto';
import { asc, sql } from 'drizzle-orm';
import { APP_AUTH_USER_COLUMNS, AUTH_SECRET_TABLES, AUTH_TABLES } from '../auth-tables.js';
import { dbInternals, type OwlwireDb } from '../handle.js';
import { q } from '../repos/context.js';
import { type RlsSubjectFlags, rlsBypassReasons, rlsSubjectQuery } from '../rls-subject.js';
import { workspaceKeys } from '../schema/index.js';
import { type SystemScope, withSystem } from '../scope.js';

export class RlsNotEnforcedError extends Error {
  constructor(readonly reasons: string[]) {
    super(
      `row level security is not enforced for the application database role: ${reasons.join('; ')}. ` +
        'Set OWLWIRE_DATABASE_URL to a dedicated application role and OWLWIRE_MIGRATION_DATABASE_URL to the table owner; ' +
        '`owlwire migrate` creates the application role.',
    );
    this.name = 'RlsNotEnforcedError';
  }
}

export class KeyringCoverageError extends Error {
  constructor(
    readonly missingVersions: number[],
    readonly mismatchedVersions: number[] = [],
  ) {
    const parts: string[] = [];
    if (missingVersions.length > 0) {
      parts.push(
        `workspace keys are wrapped with KEK version(s) ${missingVersions.join(', ')} that are not configured; ` +
          'set OWLWIRE_KEK_PREVIOUS="<version>:<base64>" until `owlwire keys rotate` finishes',
      );
    }
    if (mismatchedVersions.length > 0) {
      parts.push(
        `the configured key for KEK version(s) ${mismatchedVersions.join(', ')} does not open the stored workspace keys; ` +
          'check OWLWIRE_KEK / OWLWIRE_KEK_PREVIOUS for a wrong key under the right version',
      );
    }
    super(parts.join('. '));
    this.name = 'KeyringCoverageError';
  }
}

/**
 * Bağlantının rolü RLS'e gerçekten tabi mi: `ensureAppRole` ile aynı salt okunur denetim (`rlsSubjectQuery`) kendi
 * `current_user`'ı için çalışır — süper kullanıcı, BYPASSRLS, SUPERUSER/BYPASSRLS bir rolün üyeliği, uygulama
 * şemalarında herhangi bir ilişkinin ya da şemanın (doğrudan ya da üyelikle) sahipliği. Ayrıca politikası olan
 * (`pg_policies`) ya da `workspace_id` kolonlu her `public` tablosunda (birleşim) RLS açık olmalıdır.
 */
export async function checkRlsEnforcement(
  scope: SystemScope,
  db: OwlwireDb,
): Promise<{ enforced: boolean; reasons: string[] }> {
  const result = await withSystem(db, scope, async (s) => {
    const migrated = await q(s).execute(
      sql`select to_regclass('public.workspaces') is not null as "present"`,
    );
    if (!(migrated.rows[0] as { present: boolean } | undefined)?.present) return null;
    const subject = await q(s).execute(rlsSubjectQuery(null));
    const unprotected = await q(s).execute(sql`
      select c.relname as "table"
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
        and (
          exists (select 1 from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname)
          or exists (
            select 1 from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
          )
        )
      order by c.relname`);
    return {
      flags: subject.rows[0] as RlsSubjectFlags | undefined,
      unprotected: (unprotected.rows as Array<{ table: string }>).map((r) => r.table),
    };
  });
  if (!result) return { enforced: false, reasons: ['workspaces table not found; run migrations'] };
  const reasons = result.flags
    ? rlsBypassReasons(result.flags)
    : ['application role not found in pg_roles'];
  for (const table of result.unprotected) reasons.push(`RLS is not enabled on ${table}`);
  return { enforced: reasons.length === 0, reasons };
}

export class AuthRoleSeparationError extends Error {
  constructor(readonly reasons: string[]) {
    super(
      `the auth tables are not separated from the application database role: ${reasons.join('; ')}. ` +
        'Set OWLWIRE_AUTH_DATABASE_URL to the dedicated auth role (owlwire_auth) and run `owlwire migrate`, which ' +
        'creates the role and sets the grants of both roles.',
    );
    this.name = 'AuthRoleSeparationError';
  }
}

interface AppAuthAccess {
  role: string;
  secretTables: string[];
  userTableWide: boolean;
  userColumnWrite: boolean;
  userColumns: string[];
}

interface AuthRoleAccess {
  role: string;
  missing: string[];
}

/**
 * Whether the auth tables are reachable only through the auth role. On the application connection (`appDb`): no
 * privilege at all on AUTH_SECRET_TABLES, no table-level privilege and no INSERT/UPDATE/REFERENCES on auth_user,
 * and SELECT on no auth_user column outside APP_AUTH_USER_COLUMNS. On the auth connection (`authDb`): a different
 * role than the application's, subject to row level security exactly like the application role (no superuser,
 * BYPASSRLS, owner membership or ownership), with SELECT, INSERT, UPDATE and DELETE on every auth table. Neither
 * role may be a member of the other, in any form, since membership allows SET ROLE.
 */
export async function checkAuthRoleSeparation(
  scope: SystemScope,
  appDb: OwlwireDb,
  authDb: OwlwireDb,
): Promise<{ separated: boolean; reasons: string[] }> {
  const secret = sql`${sql.param([...AUTH_SECRET_TABLES])}::text[]`;
  const allowed = sql`${sql.param([...APP_AUTH_USER_COLUMNS])}::text[]`;
  const app = await withSystem(appDb, scope, async (s): Promise<AppAuthAccess | null> => {
    const present = await q(s).execute(
      sql`select to_regclass('public.auth_user') is not null as "present"`,
    );
    if (!(present.rows[0] as { present: boolean } | undefined)?.present) return null;
    const res = await q(s).execute(sql`
      select
        current_user::text as "role",
        coalesce((
          select array_agg(t.name order by t.name) from unnest(${secret}) as t(name)
          where to_regclass('public.' || quote_ident(t.name)) is not null
            and has_table_privilege(current_user, ('public.' || quote_ident(t.name))::regclass,
              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        ), '{}') as "secretTables",
        has_table_privilege(current_user, 'public.auth_user'::regclass,
          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as "userTableWide",
        has_any_column_privilege(current_user, 'public.auth_user'::regclass, 'INSERT, UPDATE, REFERENCES')
          as "userColumnWrite",
        coalesce((
          select array_agg(a.attname::text order by a.attnum) from pg_attribute a
          where a.attrelid = 'public.auth_user'::regclass and a.attnum > 0 and not a.attisdropped
            and a.attname <> all(${allowed})
            and has_column_privilege(current_user, a.attrelid, a.attnum, 'SELECT')
        ), '{}') as "userColumns"`);
    return res.rows[0] as unknown as AppAuthAccess;
  });
  if (!app) return { separated: false, reasons: ['auth tables not found; run migrations'] };

  const tables = sql`${sql.param([...AUTH_TABLES])}::text[]`;
  const auth = await withSystem(authDb, scope, async (s) => {
    const subject = await q(s).execute(rlsSubjectQuery(null));
    // MEMBER counts every membership, also one granted WITH INHERIT FALSE (or SET only): such a grant gives no table
    // privilege, so the checks above miss it, but SET ROLE still crosses over.
    const linked = await q(s).execute(sql`
      select coalesce(pg_has_role(a.oid, b.oid, 'MEMBER') or pg_has_role(b.oid, a.oid, 'MEMBER'), false)
        as "linked"
      from pg_roles a, pg_roles b
      where a.rolname = ${app.role} and b.rolname = current_user and a.oid <> b.oid`);
    const access = await q(s).execute(sql`
      select current_user::text as "role", coalesce((
        select array_agg(t.name order by t.name) from unnest(${tables}) as t(name)
        where to_regclass('public.' || quote_ident(t.name)) is null
          or not (
            has_table_privilege(current_user, ('public.' || quote_ident(t.name))::regclass, 'SELECT')
            and has_table_privilege(current_user, ('public.' || quote_ident(t.name))::regclass, 'INSERT')
            and has_table_privilege(current_user, ('public.' || quote_ident(t.name))::regclass, 'UPDATE')
            and has_table_privilege(current_user, ('public.' || quote_ident(t.name))::regclass, 'DELETE')
          )
      ), '{}') as "missing"`);
    return {
      flags: subject.rows[0] as RlsSubjectFlags | undefined,
      access: access.rows[0] as unknown as AuthRoleAccess,
      linked: (linked.rows[0] as { linked: boolean } | undefined)?.linked ?? false,
    };
  });

  const reasons: string[] = [];
  if (auth.access.role === app.role) {
    reasons.push(`the auth connection uses the application role ${app.role}`);
  }
  if (auth.linked)
    reasons.push(`roles ${app.role} and ${auth.access.role} are members of each other`);
  for (const table of app.secretTables) reasons.push(`application role can access ${table}`);
  if (app.userTableWide) reasons.push('application role has table-wide privileges on auth_user');
  if (app.userColumnWrite) reasons.push('application role can write auth_user columns');
  for (const column of app.userColumns)
    reasons.push(`application role can read auth_user.${column}`);
  if (auth.flags) reasons.push(...rlsBypassReasons(auth.flags, 'auth role'));
  else reasons.push('auth role not found in pg_roles');
  for (const table of auth.access.missing) {
    reasons.push(`auth role lacks SELECT, INSERT, UPDATE or DELETE on ${table}`);
  }
  return { separated: reasons.length === 0, reasons };
}

/**
 * Saklı her KEK sürümü anahtarlıkta olmalı ve doğru anahtar olmalı: her sürümden bir workspace DEK'i açılmayı dener
 * (açılan DEK hemen sıfırlanır). Yoksa DEK'ler açılamaz ve gönderimler sessizce başarısız olur. Hata yalnız sürüm
 * numaralarını taşır.
 */
export async function assertKeyringCoversKeys(scope: SystemScope, db: OwlwireDb): Promise<void> {
  const { keyring } = dbInternals(db);
  const samples = await withSystem(db, scope, (s) =>
    q(s)
      .selectDistinctOn([workspaceKeys.kekVersion], {
        version: workspaceKeys.kekVersion,
        workspaceId: workspaceKeys.workspaceId,
        wrappedDek: workspaceKeys.wrappedDek,
      })
      .from(workspaceKeys)
      .orderBy(asc(workspaceKeys.kekVersion), asc(workspaceKeys.workspaceId)),
  );
  const missing: number[] = [];
  const mismatched: number[] = [];
  for (const sample of samples) {
    if (!keyring.byVersion(sample.version)) {
      missing.push(sample.version);
      continue;
    }
    try {
      unwrapWorkspaceDek(keyring, sample.wrappedDek, sample.version, sample.workspaceId).fill(0);
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
      mismatched.push(sample.version);
    }
  }
  if (missing.length > 0 || mismatched.length > 0) {
    throw new KeyringCoverageError(missing, mismatched);
  }
}

/** `db` bu anahtarlıkla (aynı nesne) mi açıldı; anahtarlığı ayrıca alan sistem komutları için koruma. */
export function isOpenedWithKeyring(db: OwlwireDb, keyring: Keyring): boolean {
  return dbInternals(db).keyring === keyring;
}
