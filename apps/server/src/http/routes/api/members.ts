import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  type MemberDto,
  MemberListSchema,
  MemberParams,
  MemberSchema,
  TransferOwnershipInput,
  UpdateMemberInput,
  WorkspaceIdParams,
} from '@owlwire/contracts';
import type { MemberListItem } from '@owlwire/db';
import type { Deps } from '../../../deps.js';
import {
  changeMemberRole,
  listWorkspaceMembers,
  removeMember,
  transferOwnership,
} from '../../../workspaces/members.js';
import type { ApiEnv } from './env.js';
import { json, problems, SECURITY, TAGS } from './problems.js';

function toMemberDto(m: MemberListItem): MemberDto {
  return {
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
  };
}

/**
 * Members of a workspace: any member reads the list; role changes, removals and ownership transfers are decided in
 * workspaces/members.ts on the roles read under the workspace lock, so these handlers do no role check themselves.
 */
export function registerMemberRoutes(api: OpenAPIHono<ApiEnv>, deps: Deps): void {
  api.openapi(
    createRoute({
      method: 'get',
      path: '/workspaces/{workspaceId}/members',
      tags: TAGS,
      security: SECURITY,
      request: { params: WorkspaceIdParams },
      responses: { 200: json(MemberListSchema, 'Workspace members'), ...problems(401, 404) },
    }),
    async (c) => {
      const items = await listWorkspaceMembers(deps, c.get('workspace').id);
      return c.json({ items: items.map(toMemberDto) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: 'patch',
      path: '/workspaces/{workspaceId}/members/{userId}',
      tags: TAGS,
      security: SECURITY,
      request: {
        params: MemberParams,
        body: { content: { 'application/json': { schema: UpdateMemberInput } }, required: true },
      },
      responses: {
        200: json(MemberSchema, 'Updated member'),
        ...problems(400, 401, 403, 404, 409, 422),
      },
    }),
    async (c) => {
      const { userId } = c.req.valid('param');
      const { role } = c.req.valid('json');
      const item = await changeMemberRole(
        deps,
        c.get('workspace').id,
        c.get('user').id,
        userId,
        role,
      );
      return c.json(toMemberDto(item), 200);
    },
  );

  api.openapi(
    createRoute({
      method: 'delete',
      path: '/workspaces/{workspaceId}/members/{userId}',
      tags: TAGS,
      security: SECURITY,
      request: { params: MemberParams },
      responses: {
        204: { description: 'Removed, or left when the member is the caller' },
        ...problems(401, 403, 404, 409, 422),
      },
    }),
    async (c) => {
      await removeMember(
        deps,
        c.get('workspace').id,
        c.get('user').id,
        c.req.valid('param').userId,
      );
      return c.body(null, 204);
    },
  );

  api.openapi(
    createRoute({
      method: 'post',
      path: '/workspaces/{workspaceId}/transfer-ownership',
      tags: TAGS,
      security: SECURITY,
      request: {
        params: WorkspaceIdParams,
        body: {
          content: { 'application/json': { schema: TransferOwnershipInput } },
          required: true,
        },
      },
      responses: {
        204: { description: 'Ownership transferred; the previous owner is now an admin' },
        ...problems(400, 401, 403, 404, 409, 422),
      },
    }),
    async (c) => {
      await transferOwnership(
        deps,
        c.get('workspace').id,
        c.get('user').id,
        c.req.valid('json').userId,
      );
      return c.body(null, 204);
    },
  );
}
