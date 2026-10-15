import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { AuthConfigSchema } from '@owlwire/contracts';
import { INVITATION_HEADER } from '../../../auth/auth.js';
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
      description: [
        'The registration mode decides who may sign up.',
        `In \`invite\` mode an email sign-up (\`POST /api/auth/sign-up/email\`) must send the invitation token`,
        `(\`ow_inv_...\`) in the \`${INVITATION_HEADER}\` header, and the invitation must be pending and addressed`,
        'to the signing-up email; otherwise no account is created (the answer is the same `200`). Signing up does not',
        'accept the invitation: the client signs in, then calls `POST /api/invitations/accept`. A social sign-up',
        'needs a pending invitation for the address the provider verified, without the header.',
      ].join(' '),
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
