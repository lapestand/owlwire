import type { Logger } from 'pino';

export interface InstallationContext {
  id: string;
  appId: string;
  workspaceId: string;
  grantedTypes: string[] | null;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    log: Logger;
    installation: InstallationContext;
  };
};
