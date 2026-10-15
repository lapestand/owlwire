import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { MeSchema } from '@owlwire/contracts';
import { SYSTEM_ACTOR } from '@owlwire/db';
import type { Deps } from '../../../deps.js';
import { ensurePersonalWorkspace } from '../../../system/personal-workspace.js';
import { findUserById } from '../../../system/users.js';
import type { ApiEnv } from './env.js';
import { json, problems, SECURITY, TAGS } from './problems.js';

export function registerMeRoutes(api: OpenAPIHono<ApiEnv>, deps: Deps): void {
  api.openapi(
    createRoute({
      method: 'get',
      path: '/me',
      tags: TAGS,
      security: SECURITY,
      responses: { 200: json(MeSchema, 'The signed-in user'), ...problems(401) },
    }),
    async (c) => {
      const user = c.get('user');
      // Also repairs a missing personal workspace (the sign-up hook can fail after the user row committed); the
      // workspace is found by its owner, never by slug. A repair is the system's doing, not the user's.
      const [personalWorkspaceId, row] = await Promise.all([
        ensurePersonalWorkspace(deps, user, SYSTEM_ACTOR),
        findUserById(deps, user.id),
      ]);
      return c.json(
        {
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            image: row?.image ?? null,
            twoFactorEnabled: user.twoFactorEnabled,
          },
          isInstanceAdmin: user.isInstanceAdmin,
          personalWorkspaceId,
        },
        200,
      );
    },
  );
}
