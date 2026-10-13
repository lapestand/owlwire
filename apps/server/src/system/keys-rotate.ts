import type { Keyring } from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import {
  assertKeyringCoversKeys,
  countKeysByVersion,
  KeyringCoverageError,
  rotateWorkspaceKeys,
  SYSTEM,
} from '@owlwire/db/system';
import type { Logger } from 'pino';
import { upgradeLegacySecrets } from './legacy-secrets.js';

export interface KeysRotateDeps {
  db: OwlwireDb;
  keyring: Keyring;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  out: (line: string) => void;
}

const describeCounts = (counts: Map<number, number>): string =>
  [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([version, n]) => `v${version}: ${n}`)
    .join(', ');

const REMOVABLE =
  'All workspace keys use the current KEK. OWLWIRE_KEK_PREVIOUS can be removed after a restart.';

/**
 * `owlwire keys rotate` (contract §11.2): exit 0 done, 1 failures or stale keys remain, 2 missing or wrong
 * configuration. Order: keyring coverage check (every stored KEK version configured and opening its keys) ->
 * upgradeLegacySecrets (P0 secrets sealed with the old KEK move to workspace DEKs before PREVIOUS goes away) ->
 * rotateWorkspaceKeys. Output and logs carry versions, counts and workspace ids only, never key material.
 * "OWLWIRE_KEK_PREVIOUS can be removed" is printed only when no key remains on another version.
 */
export async function runKeysRotate(deps: KeysRotateDeps): Promise<number> {
  const { db, keyring, out } = deps;
  const current = keyring.current.version;

  try {
    await assertKeyringCoversKeys(SYSTEM, db);
  } catch (err) {
    if (!(err instanceof KeyringCoverageError)) throw err;
    const stale = await countKeysByVersion(SYSTEM, db);
    stale.delete(current);
    // The message names KEK versions only.
    out(`${err.message}.`);
    if (stale.size > 0) out(`Stale keys: ${describeCounts(stale)}.`);
    return 2;
  }

  const legacy = await upgradeLegacySecrets(db, keyring, deps.logger);
  if (legacy.failed.length > 0) {
    out(
      `${legacy.failed.length} legacy connection secret(s) could not be upgraded; see logs. Fix them and run again.`,
    );
    return 1;
  }

  const before = await countKeysByVersion(SYSTEM, db);
  before.delete(current);
  if (before.size === 0) {
    out(`All workspace keys are already wrapped with KEK v${current}.`);
    if (keyring.previous) out(REMOVABLE);
    return 0;
  }

  const result = await rotateWorkspaceKeys(SYSTEM, db, {
    onRotated: (workspaceId) => deps.logger.info({ workspaceId }, 'workspace key re-wrapped'),
  });
  out(`Re-wrapped ${result.rotated} workspace key(s) with KEK v${result.currentVersion}.`);
  for (const f of result.failed) {
    deps.logger.error(
      { workspaceId: f.workspaceId, error: f.error },
      'workspace key could not be re-wrapped',
    );
    out(`FAILED ${f.workspaceId}: ${f.error}`);
  }
  if (result.failed.length > 0 || result.remainingByVersion.size > 0) {
    out(
      `Remaining stale keys: ${describeCounts(result.remainingByVersion) || 'none'}. Fix the errors and run again.`,
    );
    return 1;
  }
  out(REMOVABLE);
  return 0;
}
