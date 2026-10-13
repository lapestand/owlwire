import type { OwlwireDb } from '@owlwire/db';
import {
  assertKeyringCoversKeys,
  checkRlsEnforcement,
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
 * Called when serve starts (contract §4, §11.2). If the application connection can bypass RLS (superuser, BYPASSRLS,
 * table owner, e.g. the 'same' mode without OWLWIRE_MIGRATION_DATABASE_URL) the process does not start. The only
 * exception is the explicit local-development opt-in OWLWIRE_ALLOW_INSECURE_DB_ROLE=true outside
 * NODE_ENV=production; then every reason is logged as a warning (Task 14 ruling). A keyring that does not cover
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
