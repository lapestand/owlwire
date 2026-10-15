import type { WorkspaceRole } from '@owlwire/core';
import type { WorkspaceSummary } from '@owlwire/db';

/** A workspace together with the caller's role in it; the workspace access middleware resolves it per request. */
export interface WorkspaceContext extends WorkspaceSummary {
  role: WorkspaceRole;
}
