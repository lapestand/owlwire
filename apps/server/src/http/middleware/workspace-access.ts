import {
  getMembershipContext,
  InvalidScopeError,
  type OwlwireDb,
  type TenantScope,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import type { MiddlewareHandler } from 'hono';
import type { BaseDeps } from '../../base-deps.js';
import { notFound } from '../../errors.js';
import type { WorkspaceContext } from '../../workspaces/context.js';
import type { ApiEnv } from '../routes/api/env.js';

/**
 * The membership of `userId` in `workspaceId` together with the workspace; null for a malformed id, a non-member,
 * an unknown workspace and a soft-deleted one.
 */
export async function resolveWorkspaceContext(
  db: OwlwireDb,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceContext | null> {
  let scope: TenantScope;
  try {
    scope = tenantScope(workspaceId);
  } catch (err) {
    if (err instanceof InvalidScopeError) return null;
    throw err;
  }
  const ctx = await withTenant(db, scope, (t) => getMembershipContext(t, userId));
  return ctx ? { ...ctx.workspace, role: ctx.role } : null;
}

/**
 * Loads the caller's membership of the path's workspace. Anything but a live membership answers the same 404, so a
 * caller cannot tell an unknown workspace from a foreign or deleted one. Role checks happen per route.
 */
export function workspaceAccess(deps: Pick<BaseDeps, 'db'>): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const ws = await resolveWorkspaceContext(
      deps.db,
      c.get('user').id,
      c.req.param('workspaceId') ?? '',
    );
    if (!ws) throw notFound();
    c.set('workspace', ws);
    await next();
  };
}
