import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  WorkspaceIdParams,
  WorkspaceListSchema,
  WorkspaceSchema,
} from '@owlwire/contracts';
import type { Deps } from '../../../deps.js';
import {
  createCommunityWorkspace,
  listWorkspacesForUser,
} from '../../../system/user-workspaces.js';
import { deleteWorkspace, updateWorkspaceSettings } from '../../../workspaces/settings.js';
import type { ApiEnv } from './env.js';
import {
  assertRole,
  json,
  problems,
  problemWith,
  SECURITY,
  TAGS,
  toWorkspaceDto,
} from './problems.js';

export function registerWorkspaceRoutes(api: OpenAPIHono<ApiEnv>, deps: Deps): void {
  api.openapi(
    createRoute({
      method: 'get',
      path: '/workspaces',
      tags: TAGS,
      security: SECURITY,
      responses: {
        200: json(WorkspaceListSchema, 'Live workspaces the user belongs to'),
        ...problems(401),
      },
    }),
    async (c) => {
      const items = await listWorkspacesForUser(deps, c.get('user').id);
      return c.json({ items: items.map(toWorkspaceDto) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: 'post',
      path: '/workspaces',
      tags: TAGS,
      security: SECURITY,
      request: {
        body: { content: { 'application/json': { schema: CreateWorkspaceInput } }, required: true },
      },
      responses: {
        201: json(WorkspaceSchema, 'Created community workspace'),
        ...problems(400, 401, 422),
        ...problemWith(409, 'slug_taken'),
      },
    }),
    async (c) => {
      const ws = await createCommunityWorkspace(deps, c.get('user').id, c.req.valid('json'));
      return c.json(toWorkspaceDto(ws), 201);
    },
  );

  api.openapi(
    createRoute({
      method: 'get',
      path: '/workspaces/{workspaceId}',
      tags: TAGS,
      security: SECURITY,
      request: { params: WorkspaceIdParams },
      responses: { 200: json(WorkspaceSchema, 'Workspace'), ...problems(401, 404) },
    }),
    (c) => c.json(toWorkspaceDto(c.get('workspace')), 200),
  );

  api.openapi(
    createRoute({
      method: 'patch',
      path: '/workspaces/{workspaceId}',
      tags: TAGS,
      security: SECURITY,
      request: {
        params: WorkspaceIdParams,
        body: { content: { 'application/json': { schema: UpdateWorkspaceInput } }, required: true },
      },
      responses: {
        200: json(WorkspaceSchema, 'Updated workspace'),
        ...problems(400, 401, 403, 404, 422),
        ...problemWith(409, 'slug_taken', 'personal_workspace'),
      },
    }),
    async (c) => {
      const ws = c.get('workspace');
      assertRole(ws, 'admin');
      const updated = await updateWorkspaceSettings(
        deps,
        ws,
        c.get('user').id,
        c.req.valid('json'),
      );
      return c.json(toWorkspaceDto(updated), 200);
    },
  );

  api.openapi(
    createRoute({
      method: 'delete',
      path: '/workspaces/{workspaceId}',
      tags: TAGS,
      security: SECURITY,
      request: { params: WorkspaceIdParams },
      responses: {
        204: { description: 'Marked deleted; the data is purged later' },
        ...problems(401, 403, 404),
        ...problemWith(409, 'personal_workspace'),
      },
    }),
    async (c) => {
      const ws = c.get('workspace');
      assertRole(ws, 'owner');
      await deleteWorkspace(deps, ws, c.get('user').id);
      return c.body(null, 204);
    },
  );
}
