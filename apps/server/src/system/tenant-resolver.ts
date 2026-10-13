import { type OwlwireDb, type TenantScope, tenantScope } from '@owlwire/db';
import { resolveWorkspaceOf, SYSTEM, type TenantEntityKind, withSystem } from '@owlwire/db/system';

/**
 * Worker işlerinin payload kimliğinden workspace'i sistem kapsamında bulur (Görev 12: payload'daki kimliğe kapsam
 * için güvenilmez). Sistem transaction'ı dönmeden kiracı kapsamı açılmaz.
 */
export async function resolveTenant(
  db: OwlwireDb,
  kind: TenantEntityKind,
  id: string,
): Promise<TenantScope | null> {
  const workspaceId = await withSystem(db, SYSTEM, (s) => resolveWorkspaceOf(s, kind, id));
  return workspaceId ? tenantScope(workspaceId) : null;
}
