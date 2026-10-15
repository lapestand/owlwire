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
import { roleAtLeast, type WorkspaceRole } from '@owlwire/core';
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

/** Owners and admins see every member's email; plain members see id, name, image and role only. */
function toMemberDto(m: MemberListItem, viewerRole: WorkspaceRole): MemberDto {
  return {
    userId: m.userId,
    name: m.name,
    ...(roleAtLeast(viewerRole, 'admin') ? { email: m.email } : {}),
    image: m.image,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
  };
}

/**
 * Members of a workspace: any member reads the list (emails only for owners and admins); role changes, removals and
 * ownership transfers are decided in workspaces/members.ts on the roles read under the workspace lock, so these
 * handlers do no role check themselves.
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
      const ws = c.get('workspace');
      const items = await listWorkspaceMembers(deps, ws.id);
      return c.json({ items: items.map((m) => toMemberDto(m, ws.role)) }, 200);
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
      const ws = c.get('workspace');
      const item = await changeMemberRole(deps, ws.id, c.get('user').id, userId, role);
      // Only an admin or owner can get here with a 200; the role is the one the access check read.
      return c.json(toMemberDto(item, ws.role), 200);
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
      description:
        'Owner only. Makes the target member an owner and the caller an admin. A personal workspace answers 409 ' +
        'personal_workspace, a target who is already an owner 409 already_owner, the caller as target 422 ' +
        'target_is_self and a user who is not a member 404.',
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
