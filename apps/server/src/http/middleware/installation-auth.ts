import { hashToken, isInstallationToken, verifyTokenHash } from '@owlwire/crypto';
import { type Db, installations } from '@owlwire/db';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ProblemError } from '../problem.js';
import type { AppEnv } from '../types.js';

const CHALLENGE = { 'www-authenticate': 'Bearer' };

export function extractToken(
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
  db: Db,
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
    const [row] = await db
      .select({
        id: installations.id,
        appId: installations.appId,
        workspaceId: installations.workspaceId,
        status: installations.status,
        grantedTypes: installations.grantedTypes,
        tokenHash: installations.tokenHash,
      })
      .from(installations)
      .where(eq(installations.tokenHash, hashToken(token)))
      .limit(1);
    if (!row || !verifyTokenHash(token, row.tokenHash)) {
      throw new ProblemError(401, 'unauthorized', 'invalid installation token', CHALLENGE);
    }
    if (row.status !== 'active') {
      throw new ProblemError(401, 'installation_revoked', 'installation has been revoked');
    }
    c.set('installation', {
      id: row.id,
      appId: row.appId,
      workspaceId: row.workspaceId,
      grantedTypes: row.grantedTypes,
    });
    c.set('log', c.get('log').child({ workspaceId: row.workspaceId }));
    await next();
  };
}
