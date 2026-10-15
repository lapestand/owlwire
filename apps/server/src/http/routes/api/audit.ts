import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  type AuditEntryDto,
  AuditListSchema,
  AuditQuery,
  WorkspaceIdParams,
} from '@owlwire/contracts';
import type { AuditLogRow } from '@owlwire/db';
import type { Deps } from '../../../deps.js';
import { listWorkspaceAudit } from '../../../workspaces/audit.js';
import { listWorkspaceMembers } from '../../../workspaces/members.js';
import type { ApiEnv } from './env.js';
import { assertRole, json, problems, SECURITY, TAGS } from './problems.js';

/**
 * The actor as one object. A user's name is known only while they are a member of this workspace; a former member,
 * an installation and the system have a null name (the UI shows the id instead).
 */
function toAuditDto(r: AuditLogRow, memberNames: ReadonlyMap<string, string>): AuditEntryDto {
  const actor: AuditEntryDto['actor'] = r.actorUserId
    ? { type: 'user', id: r.actorUserId, name: memberNames.get(r.actorUserId) ?? null }
    : r.actorInstallationId
      ? { type: 'installation', id: r.actorInstallationId, name: null }
      : { type: 'system', id: null, name: null };
  return {
    id: r.id,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    actor,
    data: r.data,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The workspace audit log, newest first; readable by owners and admins (403 for plain members). */
export function registerAuditRoutes(api: OpenAPIHono<ApiEnv>, deps: Deps): void {
  api.openapi(
    createRoute({
      method: 'get',
      path: '/workspaces/{workspaceId}/audit',
      tags: TAGS,
      security: SECURITY,
      request: { params: WorkspaceIdParams, query: AuditQuery },
      responses: {
        200: json(AuditListSchema, 'Workspace audit log, newest first'),
        ...problems(401, 403, 404, 422),
      },
    }),
    async (c) => {
      // Owners and admins only: entries carry member and invitee details (for example invitation emails).
      const ws = c.get('workspace');
      assertRole(ws, 'admin');
      const workspaceId = ws.id;
      const page = await listWorkspaceAudit(deps, workspaceId, c.req.valid('query'));
      const members = await listWorkspaceMembers(deps, workspaceId);
      const names = new Map(members.map((m) => [m.userId, m.name] as const));
      return c.json(
        { items: page.items.map((r) => toAuditDto(r, names)), nextCursor: page.nextCursor },
        200,
      );
    },
  );
}
