import type { Keyring } from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import {
  assertKeyringCoversKeys,
  countKeysByVersion,
  countLegacyConnectionSecrets,
  isOpenedWithKeyring,
  KeyringCoverageError,
  rotateWorkspaceKeys,
  SYSTEM,
} from '@owlwire/db/system';
import type { Logger } from 'pino';
import { upgradeLegacySecrets } from './legacy-secrets.js';

export interface KeysRotateDeps {
  /** Must be opened with `keyring` (the same object); runKeysRotate throws a TypeError otherwise. */
  db: OwlwireDb;
  /** The keyring `db` was opened with: current = OWLWIRE_KEK, previous = OWLWIRE_KEK_PREVIOUS. */
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

/** Keys on other versions and P0 secrets still sealed directly with a KEK; both need OWLWIRE_KEK_PREVIOUS. */
async function staleState(
  db: OwlwireDb,
  current: number,
): Promise<{ keys: Map<number, number>; legacy: number }> {
  const keys = await countKeysByVersion(SYSTEM, db);
  keys.delete(current);
  return { keys, legacy: await countLegacyConnectionSecrets(SYSTEM, db) };
}

/**
 * `owlwire keys rotate` (contract §11.2): exit 0 done, 1 failures or stale data remain, 2 missing or wrong
 * configuration. Order:
 * 1. keyring coverage check (every stored KEK version configured and opening its keys) -> 2;
 * 2. downgrade guard: a stored key or OWLWIRE_KEK_PREVIOUS newer than OWLWIRE_KEK_VERSION means the two keys look
 *    swapped -> 2, before anything is written;
 * 3. upgradeLegacySecrets (P0 secrets sealed with the old KEK move to workspace DEKs before PREVIOUS goes away);
 *    a secret sealed with an unconfigured KEK version -> 2, any other failure -> 1;
 * 4. rotateWorkspaceKeys;
 * 5. final recount of key versions and `kek_v0` secrets: "OWLWIRE_KEK_PREVIOUS can be removed" is printed only
 *    when both are empty, otherwise -> 1.
 * Output and logs carry versions, counts and ids only, never key material.
 */
export async function runKeysRotate(deps: KeysRotateDeps): Promise<number> {
  const { db, keyring, out } = deps;
  if (!isOpenedWithKeyring(db, keyring)) {
    throw new TypeError('runKeysRotate: db must be opened with the given keyring');
  }
  const current = keyring.current.version;

  try {
    await assertKeyringCoversKeys(SYSTEM, db);
  } catch (err) {
    if (!(err instanceof KeyringCoverageError)) throw err;
    const { keys } = await staleState(db, current);
    // The message names KEK versions only.
    out(`${err.message}.`);
    if (keys.size > 0) out(`Stale keys: ${describeCounts(keys)}.`);
    return 2;
  }

  const initial = await countKeysByVersion(SYSTEM, db);
  const newer = [...initial.keys()].filter((v) => v > current);
  const previous = keyring.previous?.version;
  if (newer.length > 0 || (previous !== undefined && previous > current)) {
    const versions = [...new Set([...newer, ...(previous !== undefined ? [previous] : [])])]
      .filter((v) => v > current)
      .sort((a, b) => a - b);
    out(
      `KEK version(s) ${versions.map((v) => `v${v}`).join(', ')} are newer than OWLWIRE_KEK_VERSION v${current}; ` +
        'OWLWIRE_KEK and OWLWIRE_KEK_PREVIOUS look swapped. Nothing was re-wrapped.',
    );
    return 2;
  }

  const legacy = await upgradeLegacySecrets(db, keyring, deps.logger);
  if (legacy.failed.length > 0) {
    const missing = [
      ...new Set(legacy.failed.flatMap((f) => (f.missingKekVersion ? [f.missingKekVersion] : []))),
    ].sort((a, b) => a - b);
    out(
      `${legacy.failed.length} legacy connection secret(s) could not be upgraded; see logs. Fix them and run again.`,
    );
    if (missing.length > 0) {
      out(
        `Legacy secrets are sealed with KEK ${missing.map((v) => `v${v}`).join(', ')}; ` +
          'set OWLWIRE_KEK_PREVIOUS="<version>:<base64>".',
      );
      return 2;
    }
    return 1;
  }

  let rotated: Awaited<ReturnType<typeof rotateWorkspaceKeys>> | null = null;
  const before = new Map(initial);
  before.delete(current);
  if (before.size === 0) {
    out(`All workspace keys are already wrapped with KEK v${current}.`);
  } else {
    rotated = await rotateWorkspaceKeys(SYSTEM, db, {
      onRotated: (workspaceId) => deps.logger.info({ workspaceId }, 'workspace key re-wrapped'),
    });
    out(`Re-wrapped ${rotated.rotated} workspace key(s) with KEK v${rotated.currentVersion}.`);
    for (const f of rotated.failed) {
      deps.logger.error(
        { workspaceId: f.workspaceId, error: f.error },
        'workspace key could not be re-wrapped',
      );
      out(`FAILED ${f.workspaceId}: ${f.error}`);
    }
  }

  // Final check: keys or P0 secrets written by another process during the run still need PREVIOUS.
  const left = await staleState(db, current);
  if ((rotated?.failed.length ?? 0) > 0 || left.keys.size > 0 || left.legacy > 0) {
    if (left.keys.size > 0 || rotated) {
      out(`Remaining stale keys: ${describeCounts(left.keys) || 'none'}.`);
    }
    if (left.legacy > 0) {
      out(`${left.legacy} legacy connection secret(s) are still sealed directly with a KEK.`);
    }
    out('Fix the errors and run again.');
    return 1;
  }
  if (rotated || keyring.previous) out(REMOVABLE);
  return 0;
}
