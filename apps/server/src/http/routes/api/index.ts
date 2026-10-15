import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { TrieRouter } from 'hono/router/trie-router';
import { AUTH_COOKIE_PREFIX } from '../../../auth/auth.js';
import type { Deps } from '../../../deps.js';
import { requireInstanceAdmin } from '../../middleware/instance-admin.js';
import { sessionAuth } from '../../middleware/session-auth.js';
import { workspaceAccess } from '../../middleware/workspace-access.js';
import { ProblemError, problem, validationProblem } from '../../problem.js';
import { registerAdminRoutes } from './admin.js';
import { registerAuditRoutes } from './audit.js';
import type { ApiEnv } from './env.js';
import { registerInvitationRoutes } from './invitations.js';
import { registerMeRoutes } from './me.js';
import { registerMemberRoutes } from './members.js';
import { crossSiteGuard, httpProblem, repositoryProblem } from './problems.js';
import { registerPublicRoutes } from './public.js';
import { registerWorkspaceRoutes } from './workspaces.js';

/** Where createApp mounts the router; the public allowlist below is matched against full request paths. */
export const API_BASE_PATH = '/api';

/**
 * The only routes that answer without a session. Every other path under the router requires one. The invitation
 * preview is public because the invitee may not have an account yet; the token in the body is its credential.
 */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  `${API_BASE_PATH}/auth-config`,
  `${API_BASE_PATH}/invitations/lookup`,
]);

/**
 * Whether a route registered on `api` (middleware aside) answers this method and full request path. Built once, after
 * every route is registered.
 */
function routeMatcher(api: OpenAPIHono<ApiEnv>): (method: string, path: string) => boolean {
  const router = new TrieRouter<true>();
  for (const route of api.routes) {
    if (route.method !== 'ALL') router.add(route.method, `${API_BASE_PATH}${route.path}`, true);
  }
  return (method, path) => router.match(method === 'HEAD' ? 'GET' : method, path)[0].length > 0;
}

/**
 * The session-authenticated management API under /api. Unsafe methods pass the cross-site guard first; every route
 * not in PUBLIC_API_PATHS then needs a session; a path no route answers is a 404 before the session check, so a
 * removed or mistyped endpoint reads as gone, not as "sign in first" (the route list is public in the open-source
 * repository, so this tells nobody anything new; a path the matcher misses is refused, never let through without a
 * session). Routes under /workspaces/{workspaceId} also need a live membership of that workspace (404 otherwise).
 * Only routes registered on this router are known to the matcher: a handler mounted on the parent app under /api
 * gets 404 here.
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
  let hasRoute: ((method: string, path: string) => boolean) | undefined;
  api.use('*', (c, next) => {
    if (PUBLIC_API_PATHS.has(c.req.path)) return next();
    hasRoute ??= routeMatcher(api);
    if (!hasRoute(c.req.method, c.req.path)) throw new ProblemError(404, 'not_found');
    return session(c, next);
  });
  api.use('/workspaces/:workspaceId', member);
  api.use('/workspaces/:workspaceId/*', member);
  api.use('/admin/*', requireInstanceAdmin());

  registerPublicRoutes(api, deps);
  registerMeRoutes(api, deps);
  registerWorkspaceRoutes(api, deps);
  registerMemberRoutes(api, deps);
  registerAuditRoutes(api, deps);
  registerInvitationRoutes(api, deps);
  registerAdminRoutes(api, deps);
  return api;
}
