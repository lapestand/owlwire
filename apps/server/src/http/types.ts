import type { Logger } from 'pino';
import type { InstallationContext } from '../auth/installation-context.js';

export type AppEnv = {
  Variables: {
    requestId: string;
    log: Logger;
    installation: InstallationContext;
  };
};
