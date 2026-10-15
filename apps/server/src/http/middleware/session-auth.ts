import type { MiddlewareHandler } from 'hono';
import type { Auth } from '../../auth/auth.js';
import type { SessionUser } from '../../auth/session-user.js';
import { ProblemError } from '../../errors.js';
import type { ApiEnv } from '../routes/api/env.js';

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

/**
 * Resolves the session cookie to the signed-in user; without a valid session the request ends with 401. When the
 * library extends the session (at most once a day of activity) it re-issues the cookie with the new lifetime; that
 * Set-Cookie is forwarded on the response, so the browser's cookie keeps sliding with the session.
 */
export function sessionAuth(auth: Auth): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const { headers, response } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    if (!response) throw new ProblemError(401, 'unauthorized');
    c.set('user', toSessionUser(response.user as RawUser));
    await next();
    for (const cookie of headers.getSetCookie()) c.res.headers.append('set-cookie', cookie);
  };
}
