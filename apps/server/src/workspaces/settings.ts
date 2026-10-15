import {
  RepoConflictError,
  softDeleteWorkspace,
  tenantScope,
  updateWorkspace,
  WORKSPACE_SLUG_UNIQUE,
  withTenant,
} from '@owlwire/db';
import type { BaseDeps } from '../base-deps.js';
import { ProblemError } from '../http/problem.js';
import type { WorkspaceContext } from '../http/routes/api/env.js';
import { notFound } from '../http/routes/api/problems.js';
import { lockForActor } from './write-lock.js';

/**
 * Renames the workspace and/or changes its slug (workspace.updated). A personal workspace keeps its slug
 * (409 personal_workspace); a taken slug is 409 slug_taken; a workspace deleted meanwhile is 404. The caller's role
 * is read again under the workspace lock (see lockForActor): a caller demoted below admin since the access check
 * gets 403, one removed meanwhile 404.
 */
export async function updateWorkspaceSettings(
  deps: Pick<BaseDeps, 'db'>,
  ws: WorkspaceContext,
  actorUserId: string,
  patch: { name?: string | undefined; slug?: string | undefined },
): Promise<WorkspaceContext> {
  if (ws.kind === 'personal' && patch.slug !== undefined) {
    throw new ProblemError(409, 'conflict', 'personal_workspace');
  }
  try {
    return await withTenant(deps.db, tenantScope(ws.id), async (t) => {
      const { role } = await lockForActor(t, actorUserId, 'admin');
      const updated = await updateWorkspace(t, patch, { kind: 'user', userId: actorUserId });
      if (!updated) throw notFound();
      return { ...updated, role };
    });
  } catch (err) {
    if (err instanceof RepoConflictError && err.constraint === WORKSPACE_SLUG_UNIQUE) {
      throw new ProblemError(409, 'conflict', 'slug_taken');
    }
    throw err;
  }
}

/**
 * Marks the workspace deleted (workspace.deleted); its data stays until a later purge. The personal workspace cannot
 * be deleted (409 personal_workspace); a workspace deleted meanwhile is 404. Like updateWorkspaceSettings, the
 * caller must still be an owner under the workspace lock (403 otherwise).
 */
export async function deleteWorkspace(
  deps: Pick<BaseDeps, 'db'>,
  ws: WorkspaceContext,
  actorUserId: string,
): Promise<void> {
  if (ws.kind === 'personal') throw new ProblemError(409, 'conflict', 'personal_workspace');
  await withTenant(deps.db, tenantScope(ws.id), async (t) => {
    await lockForActor(t, actorUserId, 'owner');
    if (!(await softDeleteWorkspace(t, { kind: 'user', userId: actorUserId }))) throw notFound();
  });
}
