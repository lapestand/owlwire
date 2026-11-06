import type { Logger } from 'pino';
import type { CatalogPrincipal, InstallationPrincipal } from '../auth/installation-context.js';

export type AppEnv = {
  Variables: {
    requestId: string;
    log: Logger;
    installation: InstallationPrincipal;
    catalogPrincipal: CatalogPrincipal;
  };
};
