import { hashToken, tokenKind, verifyTokenHash } from '@owlwire/crypto';
import type { AppRow, OwlwireDb } from '@owlwire/db';
import {
  findAppByKeyHash,
  findInstallationByTokenHash,
  type InstallationAuthRecord,
  SYSTEM,
  withSystem,
} from '@owlwire/db/system';

export type InstallationAuthResult =
  | { ok: true; installation: InstallationAuthRecord }
  | { ok: false; code: 'unauthorized' | 'installation_revoked' | 'app_not_approved' };

type AppKeyAuthResult =
  | { ok: true; app: AppRow }
  | { ok: false; code: 'unauthorized' | 'app_not_approved' };

/** Issued tokens are about 50 characters; anything far longer is refused before it is hashed. */
const MAX_TOKEN_LENGTH = 128;

/**
 * Only an app that was never approved (pending) or was rejected stops its tokens. Any other state, such as a
 * re-review of an approved app, keeps existing tokens working, so the check names these two values instead of
 * testing for "not approved".
 */
function approvalWithdrawn(status: string): boolean {
  return status === 'pending' || status === 'rejected';
}

/**
 * Installation token to installation, as one cross-workspace system read without a cache: revocation, approval
 * changes and workspace deletion apply to the next request. The system scope closes here; callers open tenant
 * scopes only afterwards (scopes do not nest).
 *
 * This check is also the guard against an installation created while its app's approval was being withdrawn:
 * createInstallation cannot lock another workspace's app row under tenant row-level security, so such an
 * installation may commit, but its token is refused here from its first use on.
 *
 * Unknown tokens, deleted installer workspaces and public apps whose owner workspace is deleted all answer
 * `unauthorized`: the installer cannot act on any of them, and the answer does not reveal which one it was.
 */
export async function authenticateInstallationToken(
  db: OwlwireDb,
  token: string,
): Promise<InstallationAuthResult> {
  if (tokenKind(token) !== 'inst' || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, code: 'unauthorized' };
  }
  const installation = await withSystem(db, SYSTEM, (s) =>
    findInstallationByTokenHash(s, hashToken(token)),
  );
  if (
    !installation ||
    !verifyTokenHash(token, installation.tokenHash) ||
    installation.workspaceDeleted ||
    installation.appOwnerWorkspaceDeleted
  ) {
    return { ok: false, code: 'unauthorized' };
  }
  if (installation.status !== 'active') return { ok: false, code: 'installation_revoked' };
  if (approvalWithdrawn(installation.appApprovalStatus)) {
    return { ok: false, code: 'app_not_approved' };
  }
  return { ok: true, installation };
}

/**
 * App key to app: the current key, or the previous key until its grace period ends (an expired previous key is
 * answered like an unknown one). A key of a pending or rejected app answers `app_not_approved`; a key of an app
 * whose owner workspace is deleted answers `unauthorized`.
 */
export async function authenticateAppKey(
  db: OwlwireDb,
  token: string,
  now: Date,
): Promise<AppKeyAuthResult> {
  if (tokenKind(token) !== 'app' || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, code: 'unauthorized' };
  }
  const found = await withSystem(db, SYSTEM, (s) => findAppByKeyHash(s, hashToken(token), now));
  if (!found || !verifyTokenHash(token, found.keyHash) || found.ownerWorkspaceDeleted) {
    return { ok: false, code: 'unauthorized' };
  }
  if (approvalWithdrawn(found.app.approvalStatus)) return { ok: false, code: 'app_not_approved' };
  return { ok: true, app: found.app };
}
