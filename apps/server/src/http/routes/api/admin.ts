import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { RegistrationSettingSchema, UpdateRegistrationSettingInput } from '@owlwire/contracts';
import type { Deps } from '../../../deps.js';
import { getRegistrationSetting, setRegistrationMode } from '../../../system/registration.js';
import type { ApiEnv } from './env.js';
import { json, problems, SECURITY, TAGS } from './problems.js';

/** Instance settings; the router lets only instance admins under /admin. */
export function registerAdminRoutes(api: OpenAPIHono<ApiEnv>, deps: Deps): void {
  api.openapi(
    createRoute({
      method: 'get',
      path: '/admin/settings/registration',
      tags: TAGS,
      security: SECURITY,
      responses: {
        200: json(RegistrationSettingSchema, 'Effective registration mode and where it comes from'),
        ...problems(401, 403),
      },
    }),
    async (c) => c.json(await getRegistrationSetting(deps), 200),
  );

  api.openapi(
    createRoute({
      method: 'put',
      path: '/admin/settings/registration',
      tags: TAGS,
      security: SECURITY,
      request: {
        body: {
          content: { 'application/json': { schema: UpdateRegistrationSettingInput } },
          required: true,
        },
      },
      responses: {
        200: json(RegistrationSettingSchema, 'Stored registration mode'),
        ...problems(400, 401, 403, 422),
      },
    }),
    async (c) => {
      const { mode } = c.req.valid('json');
      // Writes the instance-level settings.updated audit entry in the same transaction.
      await setRegistrationMode(deps, mode, { kind: 'user', userId: c.get('user').id });
      return c.json({ mode, source: 'settings' as const }, 200);
    },
  );
}
