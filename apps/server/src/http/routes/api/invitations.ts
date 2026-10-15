import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  AcceptedInvitationSchema,
  CreatedInvitationSchema,
  CreateInvitationInput,
  type InvitationDto,
  InvitationListSchema,
  InvitationParams,
  InvitationPreviewSchema,
  InvitationTokenInput,
  WorkspaceIdParams,
} from '@owlwire/contracts';
import type { InvitationRow } from '@owlwire/db';
import type { Deps } from '../../../deps.js';
import { notFound } from '../../../errors.js';
import { acceptInvitation, lookupInvitation } from '../../../system/invitation-acceptance.js';
import {
  cancelInvitation,
  inviteMember,
  listWorkspaceInvitations,
} from '../../../workspaces/invitations.js';
import type { ApiEnv } from './env.js';
import { assertRole, json, problems, SECURITY, TAGS } from './problems.js';

function toInvitationDto(i: InvitationRow): InvitationDto {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    invitedBy: i.invitedBy,
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
  };
}

/**
 * Invitations. Listing, inviting and revoking are for owners and admins (the list shows invitee emails); inviting and
 * revoking check the role again under the workspace lock. The preview (`/invitations/lookup`) is public: the token is
 * the credential, and it shows only what the invitation email already said. Accepting needs a session.
 */
export function registerInvitationRoutes(api: OpenAPIHono<ApiEnv>, deps: Deps): void {
  api.openapi(
    createRoute({
      method: 'get',
      path: '/workspaces/{workspaceId}/invitations',
      tags: TAGS,
      security: SECURITY,
      request: { params: WorkspaceIdParams },
      responses: {
        200: json(InvitationListSchema, 'Pending invitations'),
        ...problems(401, 403, 404),
      },
    }),
    async (c) => {
      const ws = c.get('workspace');
      assertRole(ws, 'admin');
      const items = await listWorkspaceInvitations(deps, ws.id);
      return c.json({ items: items.map(toInvitationDto) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: 'post',
      path: '/workspaces/{workspaceId}/invitations',
      tags: TAGS,
      security: SECURITY,
      request: {
        params: WorkspaceIdParams,
        body: {
          content: { 'application/json': { schema: CreateInvitationInput } },
          required: true,
        },
      },
      responses: {
        201: json(CreatedInvitationSchema, 'Invitation created'),
        ...problems(400, 401, 403, 404, 409, 422),
      },
    }),
    async (c) => {
      const ws = c.get('workspace');
      assertRole(ws, 'admin');
      const created = await inviteMember(
        deps,
        ws,
        c.get('user'),
        c.req.valid('json'),
        c.req.header('accept-language'),
      );
      return c.json(
        {
          invitation: toInvitationDto(created.invitation),
          acceptUrl: created.acceptUrl,
          emailSent: created.emailSent,
        },
        201,
      );
    },
  );

  api.openapi(
    createRoute({
      method: 'delete',
      path: '/workspaces/{workspaceId}/invitations/{invitationId}',
      tags: TAGS,
      security: SECURITY,
      request: { params: InvitationParams },
      responses: { 204: { description: 'Invitation revoked' }, ...problems(401, 403, 404, 422) },
    }),
    async (c) => {
      const ws = c.get('workspace');
      assertRole(ws, 'admin');
      await cancelInvitation(deps, ws.id, c.get('user').id, c.req.valid('param').invitationId);
      return c.body(null, 204);
    },
  );

  api.openapi(
    createRoute({
      method: 'post',
      path: '/invitations/lookup',
      tags: TAGS,
      request: {
        body: {
          content: { 'application/json': { schema: InvitationTokenInput } },
          required: true,
        },
      },
      responses: {
        200: json(InvitationPreviewSchema, 'Invitation preview'),
        ...problems(400, 404, 422),
      },
    }),
    async (c) => {
      const preview = await lookupInvitation(deps, c.req.valid('json').token);
      if (!preview) throw notFound();
      return c.json({ ...preview, expiresAt: preview.expiresAt.toISOString() }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: 'post',
      path: '/invitations/accept',
      tags: TAGS,
      security: SECURITY,
      request: {
        body: {
          content: { 'application/json': { schema: InvitationTokenInput } },
          required: true,
        },
      },
      responses: {
        200: json(AcceptedInvitationSchema, 'Invitation accepted'),
        ...problems(400, 401, 403, 404, 422),
      },
    }),
    async (c) =>
      c.json(await acceptInvitation(deps, c.get('user'), c.req.valid('json').token), 200),
  );
}
