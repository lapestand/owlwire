import type { WorkspaceRole } from '@owlwire/core';
import type { AuditActor, WorkspaceSummary } from '@owlwire/db';

/** A workspace together with the caller's role in it; the workspace access middleware resolves it per request. */
export interface WorkspaceContext extends WorkspaceSummary {
  role: WorkspaceRole;
}

/** The audit actor for a change a signed-in user made. */
export const userActor = (userId: string): AuditActor => ({ kind: 'user', userId });
