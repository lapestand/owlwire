import { eq } from 'drizzle-orm';
import { type AuditActor, writeAudit } from '../repos/audit.js';
import { now, q } from '../repos/context.js';
import { instanceSettings } from '../schema/index.js';
import type { SystemTx } from '../scope.js';

export async function getInstanceSetting(s: SystemTx, key: string): Promise<unknown | null> {
  const rows = await q(s)
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key));
  return rows[0]?.value ?? null;
}

/**
 * Sözleşme §6.1 + R98: değişiklik ve instance düzeyi `settings.updated` denetimi aynı transaction'da.
 * Denetime yalnız anahtar adı yazılır (`data: { keys: [key] }`), değer asla yazılmaz. Sır taşıyan değerler
 * buraya konmaz (instance_settings şifrelenmez). `updated_by` aktörden türetilir: kullanıcıysa `userId`, değilse null.
 */
export async function setInstanceSetting(
  s: SystemTx,
  key: string,
  value: unknown,
  actor: AuditActor,
): Promise<void> {
  const ts = now(s);
  const updatedBy = actor.kind === 'user' ? actor.userId : null;
  await q(s)
    .insert(instanceSettings)
    .values({ key, value, updatedAt: ts, updatedBy })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: ts, updatedBy } });
  await writeAudit(s, {
    workspaceId: null,
    action: 'settings.updated',
    actor,
    targetType: 'settings',
    targetId: key,
    data: { keys: [key] },
  });
}
