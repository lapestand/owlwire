import type { SessionUser } from '../../../auth/session-user.js';
import type { WorkspaceContext } from '../../../workspaces/context.js';

export type ApiEnv = {
  Variables: {
    requestId: string;
    user: SessionUser;
    workspace: WorkspaceContext;
  };
};
