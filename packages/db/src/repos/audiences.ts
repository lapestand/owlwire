import { newId } from '@owlwire/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { mapPgErrors, RepoNotFoundError } from '../errors.js';
import { audienceMembers, audiences, connections, destinations } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { now, q } from './context.js';
import { visible as visibleDestination } from './destinations.js';

export type AudienceRow = typeof audiences.$inferSelect;

const byId = (t: TenantTx, id: string) =>
  and(eq(audiences.workspaceId, t.workspaceId), eq(audiences.id, id));

async function assertAudience(t: TenantTx, id: string, lock = false): Promise<void> {
  const query = q(t).select({ id: audiences.id }).from(audiences).where(byId(t, id));
  const rows = lock ? await query.for('update') : await query;
  if (!rows[0]) throw new RepoNotFoundError('audience', id);
}

export async function createAudience(
  t: TenantTx,
  input: { name: string },
  actor: AuditActor,
): Promise<AudienceRow> {
  const id = newId();
  const rows = await mapPgErrors('audience', id, () =>
    q(t)
      .insert(audiences)
      .values({ id, workspaceId: t.workspaceId, name: input.name, createdAt: now(t) })
      .returning(),
  );
  const row = rows[0];
  if (!row) throw new Error('audience insert returned no row');
  await writeAudit(t, {
    action: 'audience.created',
    actor,
    targetType: 'audience',
    targetId: id,
    data: { name: input.name },
  });
  return row;
}

export async function listAudiences(t: TenantTx): Promise<AudienceRow[]> {
  return q(t)
    .select()
    .from(audiences)
    .where(eq(audiences.workspaceId, t.workspaceId))
    .orderBy(asc(audiences.name), asc(audiences.id));
}

/**
 * Bir kuralın hedefi olan liste silinemez: `rule_targets_audience_ws_fk` ON DELETE NO ACTION olduğu için silme 23503
 * verir ve RepoConflictError'a eşlenir. Üyelikler `ON DELETE CASCADE` ile birlikte gider.
 */
export async function deleteAudience(t: TenantTx, id: string, actor: AuditActor): Promise<void> {
  const rows = await mapPgErrors(
    'audience',
    id,
    () => q(t).delete(audiences).where(byId(t, id)).returning({ name: audiences.name }),
    { fkViolation: 'conflict' },
  );
  const row = rows[0];
  if (!row) throw new RepoNotFoundError('audience', id);
  await writeAudit(t, {
    action: 'audience.deleted',
    actor,
    targetType: 'audience',
    targetId: id,
    data: { name: row.name },
  });
}

/**
 * Üye kümesini atomik olarak değiştirir (aynı transaction'da sil, ekle; girdi tekilleştirilir).
 *
 * Kilit sırası: önce liste satırı `FOR UPDATE` (eşzamanlı değiştirmeler sıralanır), sonra üyelerin bağlantı satırları
 * `FOR SHARE` (kimliğe göre sıralı; `createDestination` ile aynı kip, birbirini bloklamaz). Bağlantı kilidi, eşzamanlı
 * `deleteConnection`'ın ya bu transaction'dan önce bitmesini (hedef görünmez, RepoNotFoundError) ya da sonra
 * çalışıp yeni üyelikleri de silmesini sağlar. `deleteConnection` liste satırını kilitlemez, bu yüzden
 * liste -> bağlantı sırası döngü oluşturmaz. Çağıranlar aynı transaction'da bağlantı satırını güncelleyen bir
 * çağrıdan SONRA bu fonksiyonu çağırmamalıdır (yükseltme deadlock'u; bkz. `createDestination`).
 *
 * Görünmeyen (bilinmeyen, başka workspace'in, yumuşak silinmiş ya da bağlantısı silinmiş) hedef kimliği
 * RepoNotFoundError verir; önceki küme korunur.
 */
export async function setAudienceMembers(
  t: TenantTx,
  audienceId: string,
  destinationIds: readonly string[],
  actor: AuditActor,
): Promise<void> {
  await assertAudience(t, audienceId, true);
  const unique = [...new Set(destinationIds)];
  if (unique.length > 0) {
    const first = await q(t)
      .select({ connectionId: destinations.connectionId })
      .from(destinations)
      .where(visibleDestination(t, inArray(destinations.id, unique)));
    const connectionIds = [...new Set(first.map((r) => r.connectionId))].sort();
    if (connectionIds.length > 0) {
      await q(t)
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(eq(connections.workspaceId, t.workspaceId), inArray(connections.id, connectionIds)),
        )
        .orderBy(asc(connections.id))
        .for('share');
    }
    // Kilit alındıktan sonra yeniden doğrula (READ COMMITTED: yeni anlık görüntü).
    const visibleNow = await q(t)
      .select({ id: destinations.id })
      .from(destinations)
      .where(visibleDestination(t, inArray(destinations.id, unique)));
    const seen = new Set(visibleNow.map((r) => r.id));
    const missing = unique.find((id) => !seen.has(id));
    if (missing !== undefined) throw new RepoNotFoundError('destination', missing);
  }
  const removed = await q(t)
    .delete(audienceMembers)
    .where(
      and(
        eq(audienceMembers.workspaceId, t.workspaceId),
        eq(audienceMembers.audienceId, audienceId),
      ),
    )
    .returning({ destinationId: audienceMembers.destinationId });
  if (unique.length > 0) {
    await mapPgErrors('destination', unique.join(','), () =>
      q(t)
        .insert(audienceMembers)
        .values(
          unique.map((destinationId) => ({
            audienceId,
            destinationId,
            workspaceId: t.workspaceId,
          })),
        ),
    );
  }
  await writeAudit(t, {
    action: 'audience.members_changed',
    actor,
    targetType: 'audience',
    targetId: audienceId,
    data: { before: removed.length, after: unique.length },
  });
}

/** Yumuşak silinmiş hedefler ve bağlantısı silinmiş hedefler listelenmez. */
export async function listAudienceMembers(t: TenantTx, audienceId: string): Promise<string[]> {
  await assertAudience(t, audienceId);
  const rows = await q(t)
    .select({ destinationId: audienceMembers.destinationId })
    .from(audienceMembers)
    .innerJoin(destinations, eq(destinations.id, audienceMembers.destinationId))
    .where(
      and(
        eq(audienceMembers.workspaceId, t.workspaceId),
        eq(audienceMembers.audienceId, audienceId),
        visibleDestination(t),
      ),
    )
    .orderBy(asc(audienceMembers.destinationId));
  return rows.map((r) => r.destinationId);
}

/**
 * Bilinmeyen ya da başka workspace'e ait liste kimlikleri sonuçta yer almaz; üyesi olmayan görünür liste boş dizi
 * döner. Görünmeyen hedefler dışarıda kalır. Boş girdi SQL çalıştırmaz.
 */
export async function expandAudiences(
  t: TenantTx,
  audienceIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (audienceIds.length === 0) return result;
  const ids = [...new Set(audienceIds)];
  const own = await q(t)
    .select({ id: audiences.id })
    .from(audiences)
    .where(and(eq(audiences.workspaceId, t.workspaceId), inArray(audiences.id, ids)));
  for (const { id } of own) result.set(id, []);
  if (own.length === 0) return result;
  const members = await q(t)
    .select({
      audienceId: audienceMembers.audienceId,
      destinationId: audienceMembers.destinationId,
    })
    .from(audienceMembers)
    .innerJoin(destinations, eq(destinations.id, audienceMembers.destinationId))
    .where(
      and(
        eq(audienceMembers.workspaceId, t.workspaceId),
        inArray(
          audienceMembers.audienceId,
          own.map((o) => o.id),
        ),
        visibleDestination(t),
      ),
    )
    .orderBy(asc(audienceMembers.destinationId));
  for (const m of members) result.get(m.audienceId)?.push(m.destinationId);
  return result;
}
