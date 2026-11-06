import { tokenKind } from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import type { MiddlewareHandler } from 'hono';
import type { Deps } from '../../deps.js';
import { BEARER_CHALLENGE, ProblemError } from '../../errors.js';
import {
  authenticateAppKey,
  authenticateInstallationToken,
  type InstallationAuthResult,
} from '../../system/installation-auth.js';
import type { AppEnv } from '../types.js';

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

// Fixed details only: a problem never echoes the token or tells which lookup failed.
function authProblem(code: Exclude<InstallationAuthResult, { ok: true }>['code']): ProblemError {
  switch (code) {
    case 'installation_revoked':
      return new ProblemError(
        401,
        'installation_revoked',
        'installation has been revoked',
        BEARER_CHALLENGE,
      );
    case 'app_not_approved':
      return new ProblemError(403, 'app_not_approved', 'the app is not approved');
    default:
      return new ProblemError(401, 'unauthorized', 'invalid installation token', BEARER_CHALLENGE);
  }
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
    if (!token || tokenKind(token) !== 'inst') {
      throw new ProblemError(
        401,
        'unauthorized',
        'missing or malformed installation token',
        BEARER_CHALLENGE,
      );
    }
    // System lookup (cross-tenant) finishes here; tenant scopes are opened later by the handlers.
    const result = await authenticateInstallationToken(db, token);
    if (!result.ok) throw authProblem(result.code);
    const rec = result.installation;
    c.set('installation', {
      installationId: rec.id,
      workspaceId: rec.workspaceId,
      appId: rec.appId,
      // The column is constrained to these two values; anything else is treated as the stricter one.
      appVisibility: rec.appVisibility === 'private' ? 'private' : 'public',
      grantedTypes: rec.grantedTypes,
    });
    c.set('log', c.get('log').child({ workspaceId: rec.workspaceId }));
    await next();
  };
}

/**
 * Catalog writes: the app key (current, or previous within its grace period), or an active installation token of
 * a private app in its own workspace. A public app's installation token is refused: its installers do not own it.
 */
export function catalogAuth(deps: Pick<Deps, 'db' | 'clock'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = extractToken(c.req.header('authorization'), undefined);
    const kind = token ? tokenKind(token) : null;
    if (!token || !kind) {
      throw new ProblemError(
        401,
        'unauthorized',
        'an app key (ow_app_...) or a private app installation token is required',
        BEARER_CHALLENGE,
      );
    }
    if (kind === 'app') {
      const result = await authenticateAppKey(deps.db, token, deps.clock.now());
      if (!result.ok) {
        throw result.code === 'app_not_approved'
          ? authProblem('app_not_approved')
          : new ProblemError(401, 'unauthorized', 'unknown or expired app key', BEARER_CHALLENGE);
      }
      c.set('catalogPrincipal', {
        appId: result.app.id,
        ownerWorkspaceId: result.app.ownerWorkspaceId,
        via: 'app_key',
        installationId: null,
      });
      c.set('log', c.get('log').child({ workspaceId: result.app.ownerWorkspaceId }));
      await next();
      return;
    }
    const result = await authenticateInstallationToken(deps.db, token);
    if (!result.ok) throw authProblem(result.code);
    const rec = result.installation;
    if (rec.appVisibility !== 'private' || rec.appOwnerWorkspaceId !== rec.workspaceId) {
      throw new ProblemError(
        403,
        'forbidden',
        'public apps must use their app key to update the catalog',
      );
    }
    c.set('catalogPrincipal', {
      appId: rec.appId,
      ownerWorkspaceId: rec.appOwnerWorkspaceId,
      via: 'installation',
      installationId: rec.id,
    });
    c.set('log', c.get('log').child({ workspaceId: rec.workspaceId }));
    await next();
  };
}
