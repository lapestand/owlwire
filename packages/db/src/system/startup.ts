import { DecryptError, type Keyring, unwrapWorkspaceDek } from '@owlwire/crypto';
import { asc, sql } from 'drizzle-orm';
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
 * şemalarında herhangi bir ilişkinin ya da şemanın (doğrudan ya da üyelikle) sahipliği. Ayrıca `workspace_id`
 * kolonlu her `public` tablosunda RLS açık olmalıdır.
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
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
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
