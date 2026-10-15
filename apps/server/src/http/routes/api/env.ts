import type { WorkspaceRole } from '@owlwire/core';
import type { WorkspaceSummary } from '@owlwire/db';

/** The signed-in user as the API sees it; `sessionAuth` sets it. Defined here so the middleware can import ApiEnv. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  isInstanceAdmin: boolean;
  twoFactorEnabled: boolean;
}

/** @public Set by the workspace access middleware for workspace routes. */
export interface WorkspaceContext extends WorkspaceSummary {
  role: WorkspaceRole;
}

export type ApiEnv = {
  Variables: {
    requestId: string;
    user: SessionUser;
    workspace: WorkspaceContext;
  };
};
