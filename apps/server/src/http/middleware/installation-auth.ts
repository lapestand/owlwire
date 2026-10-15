import { isInstallationToken } from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import type { MiddlewareHandler } from 'hono';
import { authenticateInstallationToken } from '../../system/installation-auth.js';
import { ProblemError } from '../problem.js';
import type { AppEnv } from '../types.js';

/** RFC 6750 challenge sent with every installation-token 401 (middleware and ingest). */
export const CHALLENGE = { 'www-authenticate': 'Bearer' };

function extractToken(
  authorization: string | undefined,
  queryToken: string | undefined,
): string | null {
  if (authorization !== undefined) {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    return m?.[1] ?? null;
  }
  return queryToken !== undefined && queryToken.length > 0 ? queryToken : null;
}

export function installationAuth(
  db: OwlwireDb,
  opts: { allowQueryToken: boolean },
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = extractToken(
      c.req.header('authorization'),
      opts.allowQueryToken ? c.req.query('token') : undefined,
    );
    if (!token || !isInstallationToken(token)) {
      throw new ProblemError(
        401,
        'unauthorized',
        'missing or malformed installation token',
        CHALLENGE,
      );
    }
    // System lookup (cross-tenant) finishes here; tenant scopes are opened later by the handlers.
    const result = await authenticateInstallationToken(db, token);
    if (!result.ok) {
      throw result.code === 'installation_revoked'
        ? new ProblemError(401, 'installation_revoked', 'installation has been revoked', CHALLENGE)
        : new ProblemError(401, 'unauthorized', 'invalid installation token', CHALLENGE);
    }
    const { id, appId, workspaceId, grantedTypes } = result.installation;
    c.set('installation', { id, appId, workspaceId, grantedTypes });
    c.set('log', c.get('log').child({ workspaceId }));
    await next();
  };
}
