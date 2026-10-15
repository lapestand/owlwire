import { listMembershipsForUser, SYSTEM, withSystem } from '@owlwire/db/system';
import type { BaseDeps } from '../base-deps.js';
import type { WorkspaceContext } from '../http/routes/api/env.js';

/** Every live workspace the user belongs to, with the user's role, oldest first. */
export async function listWorkspacesForUser(
  deps: Pick<BaseDeps, 'db'>,
  userId: string,
): Promise<WorkspaceContext[]> {
  const rows = await withSystem(deps.db, SYSTEM, (s) => listMembershipsForUser(s, userId));
  return rows.map((r) => ({ ...r.workspace, role: r.role }));
}
