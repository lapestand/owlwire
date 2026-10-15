import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { AuthConfigSchema } from '@owlwire/contracts';
import { enabledSocialProviders } from '../../../auth/social.js';
import type { Deps } from '../../../deps.js';
import { getRegistrationMode } from '../../../system/registration.js';
import type { ApiEnv } from './env.js';
import { json, TAGS } from './problems.js';

/** Named component: the instance information that later extends this object refers to it by name. */
const AuthConfigComponent = AuthConfigSchema.openapi('AuthConfig');

/** Routes that answer without a session. */
export function registerPublicRoutes(api: OpenAPIHono<ApiEnv>, deps: Deps): void {
  api.openapi(
    createRoute({
      method: 'get',
      path: '/auth-config',
      tags: TAGS,
      responses: {
        200: json(AuthConfigComponent, 'Public sign-in configuration for the sign-in page'),
      },
    }),
    async (c) =>
      c.json(
        {
          registration: await getRegistrationMode(deps),
          socialProviders: enabledSocialProviders(deps.authEnv),
          emailEnabled: deps.mailer !== null,
          passkeys: true,
        },
        200,
      ),
  );
}
