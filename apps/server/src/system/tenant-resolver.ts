import { type OwlwireDb, type TenantScope, tenantScope } from '@owlwire/db';
import { resolveWorkspaceOf, SYSTEM, type TenantEntityKind, withSystem } from '@owlwire/db/system';

/**
 * Worker işlerinin payload kimliğinden workspace'i sistem kapsamında bulur (payload'daki kimliğe kapsam
 * için güvenilmez). Sistem transaction'ı dönmeden kiracı kapsamı açılmaz.
 */
/** Re-exported so callers outside system/** need not import @owlwire/db/system, which is reserved for apps/server/src/system. */
export type { TenantEntityKind };

export async function resolveTenant(
  db: OwlwireDb,
  kind: TenantEntityKind,
  id: string,
): Promise<TenantScope | null> {
  const workspaceId = await withSystem(db, SYSTEM, (s) => resolveWorkspaceOf(s, kind, id));
  return workspaceId ? tenantScope(workspaceId) : null;
}
