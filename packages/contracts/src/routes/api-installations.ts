import { createRoute } from '@hono/zod-openapi';
import {
  InstallationCreatedResponse,
  InstallationCreateInput,
  InstallationListResponse,
  InstallationUpdateInput,
  InstallationView,
} from '../schemas/installations.js';
import { jsonContent, problemResponses, UuidParam, WorkspaceParams } from './common.js';

const tags = ['internal', 'installations'];
const security = [{ cookieAuth: [] }];
const InstallationParams = WorkspaceParams.extend({ installationId: UuidParam('installationId') });

export const listInstallationsRoute = createRoute({
  method: 'get',
  path: '/workspaces/{workspaceId}/installations',
  tags,
  security,
  request: { params: WorkspaceParams },
  responses: {
    200: jsonContent(InstallationListResponse, 'Installations of the workspace'),
    ...problemResponses(401, 404, 422),
  },
});

export const createInstallationRoute = createRoute({
  method: 'post',
  path: '/workspaces/{workspaceId}/installations',
  tags,
  security,
  request: {
    params: WorkspaceParams,
    body: { required: true, content: { 'application/json': { schema: InstallationCreateInput } } },
  },
  responses: {
    201: jsonContent(
      InstallationCreatedResponse,
      'Created; the token is shown only in this response',
    ),
    ...problemResponses(400, 401, 403, 404, 422),
  },
});

export const updateInstallationRoute = createRoute({
  method: 'patch',
  path: '/workspaces/{workspaceId}/installations/{installationId}',
  tags,
  security,
  request: {
    params: InstallationParams,
    body: { required: true, content: { 'application/json': { schema: InstallationUpdateInput } } },
  },
  responses: {
    200: jsonContent(InstallationView, 'Updated'),
    ...problemResponses(400, 401, 403, 404, 409, 422),
  },
});

export const revokeInstallationRoute = createRoute({
  method: 'post',
  path: '/workspaces/{workspaceId}/installations/{installationId}/revoke',
  tags,
  security,
  request: { params: InstallationParams },
  responses: {
    204: { description: 'Revoked (also when it was already revoked)' },
    ...problemResponses(401, 403, 404, 422),
  },
});
