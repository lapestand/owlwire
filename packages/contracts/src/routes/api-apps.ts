import { createRoute } from '@hono/zod-openapi';
import {
  AppCreatedResponse,
  AppCreateInput,
  AppDetail,
  AppKeyRotatedResponse,
  AppListResponse,
  AvailableAppListResponse,
} from '../schemas/apps.js';
import { CatalogPutInput, CatalogResponse } from '../schemas/catalog.js';
import { jsonContent, problemResponses, UuidParam, WorkspaceParams } from './common.js';

// Paths are relative to the server's /api router; the document shows them under /api.
const tags = ['internal', 'apps'];
const security = [{ cookieAuth: [] }];
const AppParams = WorkspaceParams.extend({ appId: UuidParam('appId') });

export const listAppsRoute = createRoute({
  method: 'get',
  path: '/workspaces/{workspaceId}/apps',
  tags,
  security,
  request: { params: WorkspaceParams },
  responses: {
    200: jsonContent(AppListResponse, 'Apps owned by the workspace'),
    ...problemResponses(401, 404, 422),
  },
});

export const createAppRoute = createRoute({
  method: 'post',
  path: '/workspaces/{workspaceId}/apps',
  tags,
  security,
  request: {
    params: WorkspaceParams,
    body: { required: true, content: { 'application/json': { schema: AppCreateInput } } },
  },
  responses: {
    201: jsonContent(AppCreatedResponse, 'Created; secrets are shown only in this response'),
    ...problemResponses(400, 401, 403, 404, 422),
  },
});

// Registered before getAppRoute: otherwise the router captures "available" as an appId.
export const listAvailableAppsRoute = createRoute({
  method: 'get',
  path: '/workspaces/{workspaceId}/apps/available',
  tags,
  security,
  request: { params: WorkspaceParams },
  responses: {
    200: jsonContent(
      AvailableAppListResponse,
      'Apps this workspace may install (own apps and approved public apps)',
    ),
    ...problemResponses(401, 404, 422),
  },
});

export const getAppRoute = createRoute({
  method: 'get',
  path: '/workspaces/{workspaceId}/apps/{appId}',
  tags,
  security,
  request: { params: AppParams },
  responses: {
    200: jsonContent(AppDetail, 'App with its catalog'),
    ...problemResponses(401, 404, 422),
  },
});

export const rotateAppKeyRoute = createRoute({
  method: 'post',
  path: '/workspaces/{workspaceId}/apps/{appId}/keys/rotate',
  tags,
  security,
  request: { params: AppParams },
  responses: {
    200: jsonContent(AppKeyRotatedResponse, 'New key; the previous key stays valid for 24 hours'),
    ...problemResponses(401, 403, 404, 422),
  },
});

export const putAppCatalogRoute = createRoute({
  method: 'put',
  path: '/workspaces/{workspaceId}/apps/{appId}/catalog',
  tags,
  security,
  request: {
    params: AppParams,
    body: { required: true, content: { 'application/json': { schema: CatalogPutInput } } },
  },
  responses: {
    200: jsonContent(CatalogResponse, 'Catalog after the update'),
    ...problemResponses(400, 401, 403, 404, 422),
  },
});
