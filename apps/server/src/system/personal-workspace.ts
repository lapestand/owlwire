import { clampWorkspaceName, newId, personalSlug } from '@owlwire/core';
import {
  type AuditActor,
  addMembership,
  createWorkspace,
  RepoConflictError,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import { findPersonalWorkspaceByOwner, SYSTEM, withSystem } from '@owlwire/db/system';
import type { BaseDeps } from '../base-deps.js';

const SLUG_UNIQUE = 'workspaces_slug_unique';

/** The user's name within the API's workspace name limit (same measure), or 'Personal' when blank. */
function personalName(name: string): string {
  const cut = clampWorkspaceName(name);
  return cut.length > 0 ? cut : 'Personal';
}

async function findLive(deps: Pick<BaseDeps, 'db'>, userId: string): Promise<string | null> {
  const ws = await withSystem(deps.db, SYSTEM, (s) => findPersonalWorkspaceByOwner(s, userId));
  return ws?.id ?? null;
}

/** The workspace, its data key, the owner membership and both audit entries in one transaction. */
function create(
  deps: Pick<BaseDeps, 'db'>,
  user: { id: string; name: string },
  id: string,
  slug: string,
): Promise<string> {
  const actor: AuditActor = { kind: 'user', userId: user.id };
  return withTenant(deps.db, tenantScope(id), async (t) => {
    const ws = await createWorkspace(
      t,
      { name: personalName(user.name), slug, kind: 'personal', ownerUserId: user.id },
      actor,
    );
    await addMembership(t, { userId: user.id, role: 'owner', via: 'create' }, actor);
    return ws.id;
  });
}

/**
 * Answers the id of the user's live personal workspace, creating it when missing. Safe to call again and from
 * concurrent requests: the unique index on the live personal workspace of an owner (deleted ones do not count) lets
 * exactly one insert win, and a loser re-reads the winner's row. The workspace and its owner membership commit
 * together, so a failure leaves nothing half-made and the next call simply tries again.
 *
 * The personal slug is derived from the user id. A deleted personal workspace keeps that slug (slugs stay taken after
 * a soft delete), so its replacement takes the personal slug derived from its own workspace id.
 */
export async function ensurePersonalWorkspace(
  deps: Pick<BaseDeps, 'db'>,
  user: { id: string; name: string },
): Promise<string> {
  const existing = await findLive(deps, user.id);
  if (existing) return existing;
  let slugTaken = false;
  try {
    return await create(deps, user, newId(), personalSlug(user.id));
  } catch (err) {
    if (!(err instanceof RepoConflictError)) throw err;
    const winner = await findLive(deps, user.id);
    if (winner) return winner;
    if (err.constraint !== SLUG_UNIQUE) throw err;
    slugTaken = true;
  }
  const id = newId();
  try {
    return await create(deps, user, id, personalSlug(id));
  } catch (err) {
    if (!(err instanceof RepoConflictError) || !slugTaken) throw err;
    const winner = await findLive(deps, user.id);
    if (winner) return winner;
    throw err;
  }
}
