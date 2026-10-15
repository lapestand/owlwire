import type { MiddlewareHandler } from 'hono';
import { ProblemError } from '../problem.js';
import type { ApiEnv } from '../routes/api/env.js';

/**
 * Instance admins are users with auth_user.is_instance_admin set (`owlwire admin create`). Runs after the session
 * middleware; anyone else gets 403 forbidden.
 */
export function requireInstanceAdmin(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (!c.get('user').isInstanceAdmin) throw new ProblemError(403, 'forbidden');
    await next();
  };
}
