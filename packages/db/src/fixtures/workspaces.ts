/**
 * Shared test fixtures (`@owlwire/db/fixtures`): seed workspaces, memberships and invitations through the repository
 * functions. Test code only; dependency-cruiser and Biome reject imports from application code.
 */
import { type InvitableRole, newId, type WorkspaceRole } from '@owlwire/core';
import type { OwlwireDb } from '../handle.js';
import { listAuditLog, SYSTEM_ACTOR } from '../repos/audit.js';
import { createInvitation } from '../repos/invitations.js';
import { addMembership } from '../repos/memberships.js';
import { createWorkspace } from '../repos/workspaces.js';
import { tenantScope, withTenant } from '../scope.js';

/** Community workspace (with its data key and workspace.created audit) owned by ownerUserId; answers its id. */
export async function seedCommunityWorkspace(
  db: OwlwireDb,
  ownerUserId: string,
  name = 'Test Alliance',
): Promise<string> {
  const id = newId();
  await withTenant(db, tenantScope(id), async (t) => {
    await createWorkspace(
      t,
      { name, slug: `test-${id.replace(/-/g, '').slice(-12)}`, kind: 'community' },
      SYSTEM_ACTOR,
    );
    await addMembership(t, { userId: ownerUserId, role: 'owner', via: 'create' }, SYSTEM_ACTOR);
  });
  return id;
}

export async function seedMembership(
  db: OwlwireDb,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  await withTenant(db, tenantScope(workspaceId), (t) =>
    addMembership(t, { userId, role }, SYSTEM_ACTOR),
  );
}

/** Stores an invitation by token hash; tests hash their own token, so the plain token stays in the test. */
export async function seedInvitation(
  db: OwlwireDb,
  input: {
    workspaceId: string;
    email: string;
    tokenHash: string;
    expiresAt: Date;
    role?: InvitableRole;
    invitedBy?: string | null;
  },
): Promise<{ id: string }> {
  const row = await withTenant(db, tenantScope(input.workspaceId), (t) =>
    createInvitation(
      t,
      {
        email: input.email,
        role: input.role ?? 'member',
        tokenHash: input.tokenHash,
        invitedBy: input.invitedBy ?? null,
        expiresAt: input.expiresAt,
      },
      SYSTEM_ACTOR,
    ),
  );
  return { id: row.id };
}

/** Audit actions of the workspace, newest first (at most 200). */
export async function listAuditActions(db: OwlwireDb, workspaceId: string): Promise<string[]> {
  const rows = await withTenant(db, tenantScope(workspaceId), (t) =>
    listAuditLog(t, { limit: 200 }),
  );
  return rows.map((r) => r.action);
}
