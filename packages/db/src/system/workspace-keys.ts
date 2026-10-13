import { eq, isNull, sql } from 'drizzle-orm';
import { RepoNotFoundError } from '../errors.js';
import type { OwlwireDb } from '../handle.js';
import { type AuditActor, SYSTEM_ACTOR, writeAudit } from '../repos/audit.js';
import { q } from '../repos/context.js';
import { insertWorkspaceKey } from '../repos/workspace-keys.js';
import { workspaceKeys, workspaces } from '../schema/index.js';
import { type SystemScope, tenantScope, withSystem, withTenant } from '../scope.js';

/**
 * Anahtarı olmayan (P0'dan kalan) workspace'lere DEK üretir; oluşturulan sayıyı döndürür.
 * Kapsamlar iç içe açılamaz (NestedScopeError), bu yüzden önce bir sistem transaction'ında eksikler
 * listelenir, sonra her workspace için ayrı bir kiracı transaction'ında anahtar ve `keys.dek_created`
 * denetim kaydı birlikte yazılır. İdempotent ve eşzamanlı çalıştırmaya dayanıklı: `ifMissing`
 * (ON CONFLICT DO NOTHING) yarışı kaybeden çağrıda false döner, kayıt ve denetim tekrarlanmaz.
 * Soft-delete edilmiş (deleted_at dolu) workspace'ler bilerek dahildir: sırları geri yükleme ya da
 * temizlik için hâlâ çözülebilmelidir; buraya deleted_at filtresi eklemeyin.
 * Listeleme ile anahtar yazımı arasında hard-delete edilen workspace (FK ihlali, RepoNotFoundError)
 * atlanır ve sayılmaz; diğer hatalar yayılır.
 */
export async function backfillWorkspaceKeys(
  scope: SystemScope,
  db: OwlwireDb,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<number> {
  const ids = await withSystem(db, scope, async (s) => {
    const rows = await q(s)
      .select({ id: workspaces.id })
      .from(workspaces)
      .leftJoin(workspaceKeys, eq(workspaceKeys.workspaceId, workspaces.id))
      .where(isNull(workspaceKeys.workspaceId))
      .orderBy(workspaces.id);
    return rows.map((r) => r.id);
  });
  let created = 0;
  for (const id of ids) {
    let inserted: boolean;
    try {
      inserted = await withTenant(db, tenantScope(id), async (t) => {
        const did = await insertWorkspaceKey(t, { ifMissing: true });
        if (did) {
          await writeAudit(t, {
            action: 'keys.dek_created',
            actor,
            targetType: 'keys',
            targetId: id,
          });
        }
        return did;
      });
    } catch (err) {
      // Workspace listelemeden sonra silindi; anahtar gereksiz.
      if (err instanceof RepoNotFoundError) continue;
      throw err;
    }
    if (inserted) created++;
  }
  return created;
}

/** KEK sürümü başına workspace anahtarı sayısı (açılış denetimi: anahtarlık saklı her sürümü kapsamalı). */
export async function countKeysByVersion(
  scope: SystemScope,
  db: OwlwireDb,
): Promise<Map<number, number>> {
  const rows = await withSystem(db, scope, (s) =>
    q(s)
      .select({ version: workspaceKeys.kekVersion, n: sql<number>`count(*)::int` })
      .from(workspaceKeys)
      .groupBy(workspaceKeys.kekVersion),
  );
  return new Map(rows.map((r) => [r.version, r.n]));
}
