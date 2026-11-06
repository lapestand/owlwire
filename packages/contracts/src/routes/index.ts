import type { RouteConfig } from '@hono/zod-openapi';
import { decideAppApprovalRoute, listAppApprovalsRoute } from './api-app-approvals.js';
import {
  createAppRoute,
  getAppRoute,
  listAppsRoute,
  listAvailableAppsRoute,
  putAppCatalogRoute,
  rotateAppKeyRoute,
} from './api-apps.js';
import {
  createInstallationRoute,
  listInstallationsRoute,
  revokeInstallationRoute,
  updateInstallationRoute,
} from './api-installations.js';
import { getEventRoute, postEventsRoute, postHooksRoute, putCatalogRoute } from './v1.js';

export * from './api-app-approvals.js';
export * from './api-apps.js';
export * from './api-installations.js';
export * from './common.js';
export * from './v1.js';

/** Every route of the apps, installations and ingestion API: /v1 routes use full paths, management routes are relative to /api. */
export const allRoutes: readonly RouteConfig[] = [
  postEventsRoute,
  getEventRoute,
  postHooksRoute,
  putCatalogRoute,
  listAppsRoute,
  createAppRoute,
  listAvailableAppsRoute,
  getAppRoute,
  rotateAppKeyRoute,
  putAppCatalogRoute,
  listInstallationsRoute,
  createInstallationRoute,
  updateInstallationRoute,
  revokeInstallationRoute,
  listAppApprovalsRoute,
  decideAppApprovalRoute,
];
