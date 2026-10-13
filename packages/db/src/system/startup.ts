import { sql } from 'drizzle-orm';
import { dbInternals, type OwlwireDb } from '../handle.js';
import { q } from '../repos/context.js';
import { type SystemScope, withSystem } from '../scope.js';
import { countKeysByVersion } from './workspace-keys.js';

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
  constructor(readonly missingVersions: number[]) {
    super(
      `workspace keys are wrapped with KEK version(s) ${missingVersions.join(', ')} that are not configured; ` +
        'set OWLWIRE_KEK_PREVIOUS="<version>:<base64>" until `owlwire keys rotate` finishes',
    );
    this.name = 'KeyringCoverageError';
  }
}

interface RlsRow {
  isSuper: boolean;
  bypassRls: boolean;
  ownsTables: boolean;
  memberOfOwner: boolean;
  rlsEnabled: boolean;
}

/**
 * Bağlantının rolü RLS'e gerçekten tabi mi: süper kullanıcı, BYPASSRLS, tablo sahibi (ya da sahibin üyesi) RLS'i
 * aşar. `workspaces` tablosu temsilcidir (bütün kiracı tabloları aynı sahiptedir).
 */
export async function checkRlsEnforcement(
  scope: SystemScope,
  db: OwlwireDb,
): Promise<{ enforced: boolean; reasons: string[] }> {
  const row = await withSystem(db, scope, async (s) => {
    const res = await q(s).execute(sql`
      select r.rolsuper as "isSuper",
             r.rolbypassrls as "bypassRls",
             t.tableowner = current_user as "ownsTables",
             pg_has_role(current_user, t.tableowner, 'MEMBER') as "memberOfOwner",
             c.relrowsecurity as "rlsEnabled"
      from pg_roles r
      cross join pg_tables t
      join pg_class c on c.relname = t.tablename and c.relnamespace = 'public'::regnamespace
      where r.rolname = current_user and t.schemaname = 'public' and t.tablename = 'workspaces'`);
    return res.rows[0] as RlsRow | undefined;
  });
  if (!row) return { enforced: false, reasons: ['workspaces table not found; run migrations'] };
  const reasons: string[] = [];
  if (row.isSuper) reasons.push('application role is SUPERUSER');
  if (row.bypassRls) reasons.push('application role has BYPASSRLS');
  if (row.ownsTables) reasons.push('application role owns the tables');
  else if (row.memberOfOwner) reasons.push('application role is a member of the table owner role');
  if (!row.rlsEnabled) reasons.push('RLS is not enabled on workspaces');
  return { enforced: reasons.length === 0, reasons };
}

/** Saklı her KEK sürümü anahtarlıkta olmalı; yoksa DEK'ler açılamaz ve gönderimler sessizce başarısız olur. */
export async function assertKeyringCoversKeys(scope: SystemScope, db: OwlwireDb): Promise<void> {
  const { keyring } = dbInternals(db);
  const counts = await countKeysByVersion(scope, db);
  const missing = [...counts.keys()].filter((v) => !keyring.byVersion(v)).sort((a, b) => a - b);
  if (missing.length > 0) throw new KeyringCoverageError(missing);
}
