import type { MiddlewareHandler } from 'hono';
import type { Auth } from '../../auth/auth.js';
import { ProblemError } from '../problem.js';
import type { ApiEnv, SessionUser } from '../routes/api/env.js';

export type { SessionUser } from '../routes/api/env.js';

interface RawUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  isInstanceAdmin?: boolean | null;
  twoFactorEnabled?: boolean | null;
}

/** Only the fields the API uses; flags the session lacks are false. */
export function toSessionUser(u: RawUser): SessionUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    emailVerified: u.emailVerified,
    isInstanceAdmin: u.isInstanceAdmin === true,
    twoFactorEnabled: u.twoFactorEnabled === true,
  };
}

/** Resolves the session cookie to the signed-in user; without a valid session the request ends with 401. */
export function sessionAuth(auth: Auth): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const result = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!result) throw new ProblemError(401, 'unauthorized');
    c.set('user', toSessionUser(result.user as RawUser));
    await next();
  };
}
