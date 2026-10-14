import type { OwlwireDb } from '@owlwire/db';
import {
  assertKeyringCoversKeys,
  checkRlsEnforcement,
  type LegacyUpgradeResult,
  RlsNotEnforcedError,
  SYSTEM,
} from '@owlwire/db/system';

export interface StartupCheckOptions {
  /** ServerConfig.allowInsecureDbRole (OWLWIRE_ALLOW_INSECURE_DB_ROLE=true). */
  allowInsecureDbRole?: boolean;
  /** process.env.NODE_ENV; the opt-in is ignored when it is 'production'. */
  nodeEnv?: string | undefined;
  logger?: { warn(obj: { reason: string }, msg: string): void };
}

/**
 * Called when serve starts. If the application connection can bypass RLS (superuser, BYPASSRLS,
 * table owner, e.g. the 'same' mode without OWLWIRE_MIGRATION_DATABASE_URL) the process does not start. The only
 * exception is the explicit local-development opt-in OWLWIRE_ALLOW_INSECURE_DB_ROLE=true outside
 * NODE_ENV=production; then every reason is logged as a warning. A keyring that does not cover
 * or does not open the stored workspace keys refuses in every environment.
 */
export async function runStartupChecks(
  db: OwlwireDb,
  opts: StartupCheckOptions = {},
): Promise<void> {
  const rls = await checkRlsEnforcement(SYSTEM, db);
  if (!rls.enforced) {
    if (!opts.allowInsecureDbRole || opts.nodeEnv === 'production') {
      throw new RlsNotEnforcedError(rls.reasons);
    }
    for (const reason of rls.reasons) {
      opts.logger?.warn(
        { reason },
        'row level security is NOT enforced for the application database role (allowed by OWLWIRE_ALLOW_INSECURE_DB_ROLE)',
      );
    }
  }
  await assertKeyringCoversKeys(SYSTEM, db);
}

/** Legacy (`kek_v0`) connection secrets are sealed with KEK versions the keyring does not hold. Versions only. */
export class LegacyKeyringCoverageError extends Error {
  constructor(readonly missingKekVersions: readonly number[]) {
    super(
      `legacy connection secrets are sealed with KEK ${missingKekVersions.map((v) => `v${v}`).join(', ')}, ` +
        'which is not in the keyring; set OWLWIRE_KEK_PREVIOUS="<version>:<base64>" to that key and restart',
    );
    this.name = 'LegacyKeyringCoverageError';
  }
}

/**
 * Final review M6: the startup legacy upgrade tries to open every `kek_v0` secret with the injected SecretBox
 * decryptor (db never learns that format). When any failed only because its KEK version is not configured, serve
 * refuses to start instead of running with connections whose every delivery would fail permanently. Rows that did
 * open are already upgraded; other failures (corrupt rows) are logged by the upgrade and do not block startup.
 */
export function assertLegacySecretsCovered(result: Pick<LegacyUpgradeResult, 'failed'>): void {
  const missing = [
    ...new Set(result.failed.flatMap((f) => (f.missingKekVersion ? [f.missingKekVersion] : []))),
  ].sort((a, b) => a - b);
  if (missing.length > 0) throw new LegacyKeyringCoverageError(missing);
}
