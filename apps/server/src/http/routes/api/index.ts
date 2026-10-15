import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { AUTH_COOKIE_PREFIX } from '../../../auth/auth.js';
import type { Deps } from '../../../deps.js';
import { sessionAuth } from '../../middleware/session-auth.js';
import { workspaceAccess } from '../../middleware/workspace-access.js';
import { ProblemError, problem, validationProblem } from '../../problem.js';
import { registerAuditRoutes } from './audit.js';
import type { ApiEnv } from './env.js';
import { registerMeRoutes } from './me.js';
import { registerMemberRoutes } from './members.js';
import { crossSiteGuard, httpProblem, repositoryProblem } from './problems.js';
import { registerPublicRoutes } from './public.js';
import { registerWorkspaceRoutes } from './workspaces.js';

/** Where createApp mounts the router; the public allowlist below is matched against full request paths. */
export const API_BASE_PATH = '/api';

/** The only routes that answer without a session. Every other path under the router requires one. */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([`${API_BASE_PATH}/auth-config`]);

/**
 * The session-authenticated management API under /api. Unsafe methods pass the cross-site guard first; every route
 * not in PUBLIC_API_PATHS then needs a session; routes under /workspaces/{workspaceId} also need a live membership
 * of that workspace (404 otherwise).
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
    // Client errors the framework raises (malformed JSON, a body that is not JSON): fixed details, never a 500.
    if (err instanceof HTTPException && err.status < 500)
      return problem(c, httpProblem(err.status));
    throw err;
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: `${AUTH_COOKIE_PREFIX}.session_token`,
  });

  const session = sessionAuth(deps.auth);
  const member = workspaceAccess(deps);
  api.use('*', crossSiteGuard(deps.authEnv.baseURL));
  api.use('*', (c, next) => (PUBLIC_API_PATHS.has(c.req.path) ? next() : session(c, next)));
  api.use('/workspaces/:workspaceId', member);
  api.use('/workspaces/:workspaceId/*', member);

  registerPublicRoutes(api, deps);
  registerMeRoutes(api, deps);
  registerWorkspaceRoutes(api, deps);
  registerMemberRoutes(api, deps);
  registerAuditRoutes(api, deps);
  return api;
}
