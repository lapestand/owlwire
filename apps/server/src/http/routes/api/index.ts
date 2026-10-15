import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { AUTH_COOKIE_PREFIX } from '../../../auth/auth.js';
import type { Deps } from '../../../deps.js';
import { sessionAuth } from '../../middleware/session-auth.js';
import { workspaceAccess } from '../../middleware/workspace-access.js';
import { ProblemError, problem, validationProblem } from '../../problem.js';
import type { ApiEnv } from './env.js';
import { registerMeRoutes } from './me.js';
import { repositoryProblem } from './problems.js';
import { registerPublicRoutes } from './public.js';
import { registerWorkspaceRoutes } from './workspaces.js';

/** Fixed detail of the 400 for an unparsable JSON body; the parser's message may quote the body. */
const MALFORMED_JSON_DETAIL = 'The request body is not valid JSON.';

/**
 * The session-authenticated management API under /api. Every route except the public ones needs a session; routes
 * under /workspaces/{workspaceId} also need a live membership of that workspace (404 otherwise).
 */
export function createApiRouter(deps: Deps): OpenAPIHono<ApiEnv> {
  const api = new OpenAPIHono<ApiEnv>({
    defaultHook: (result) => {
      if (!result.success) throw validationProblem(result.error.issues);
    },
  });
  // Problem errors and data layer errors become Problem Details here, so the session middleware still runs its
  // after-step (forwarding a re-issued cookie). Anything else goes on to createApp's handler (logged 500).
  api.onError((err, c) => {
    if (err instanceof ProblemError) return problem(c, err);
    const mapped = repositoryProblem(err);
    if (mapped) return problem(c, mapped);
    if (err instanceof HTTPException && err.status === 400) {
      return problem(c, new ProblemError(400, 'validation_failed', MALFORMED_JSON_DETAIL));
    }
    throw err;
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: `${AUTH_COOKIE_PREFIX}.session_token`,
  });

  const session = sessionAuth(deps.auth);
  const member = workspaceAccess(deps);
  api.use('/me', session);
  api.use('/workspaces', session);
  api.use('/workspaces/*', session);
  api.use('/workspaces/:workspaceId', member);
  api.use('/workspaces/:workspaceId/*', member);

  registerPublicRoutes(api, deps);
  registerMeRoutes(api, deps);
  registerWorkspaceRoutes(api, deps);
  return api;
}
