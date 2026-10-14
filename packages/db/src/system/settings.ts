import { eq, sql } from 'drizzle-orm';
import { type AuditActor, writeAudit } from '../repos/audit.js';
import { now, q } from '../repos/context.js';
import { instanceSettings } from '../schema/index.js';
import type { SystemTx } from '../scope.js';

/** `setInstanceSetting` değeri JSON'a çevrilemiyor (`undefined`); SQL'e gitmeden reddedilir. */
export class InvalidSettingValueError extends Error {
  constructor(readonly key: string) {
    super(`instance setting ${key} must have a JSON value (undefined is not allowed)`);
    this.name = 'InvalidSettingValueError';
  }
}

/**
 * Anahtarın değeri; anahtar yoksa null. Saklanan JSON `null` da null döner, yani ikisi ayırt edilemez:
 * "ayar yok" anlamı taşıyacak bir ayara JSON null yazmayın.
 */
export async function getInstanceSetting(s: SystemTx, key: string): Promise<unknown | null> {
  const rows = await q(s)
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key));
  return rows[0]?.value ?? null;
}

/**
 * Değişiklik ve instance düzeyi `settings.updated` denetimi aynı transaction'da.
 * Denetime yalnız anahtar adı yazılır (`data: { keys: [key] }`), değer asla yazılmaz. Sır taşıyan değerler
 * buraya konmaz (instance_settings şifrelenmez). `undefined` değer `InvalidSettingValueError`; JSON null saklanabilir ama
 * `getInstanceSetting` onu eksik anahtardan ayırt edemez. `updated_by` aktörden türetilir: kullanıcıysa `userId`, değilse null.
 */
export async function setInstanceSetting(
  s: SystemTx,
  key: string,
  value: unknown,
  actor: AuditActor,
): Promise<void> {
  if (value === undefined) throw new InvalidSettingValueError(key);
  const ts = now(s);
  const updatedBy = actor.kind === 'user' ? actor.userId : null;
  // Drizzle binds a JS null as SQL NULL (the column is NOT NULL); a JSON null is written explicitly.
  const json = value === null ? sql`'null'::jsonb` : value;
  await q(s)
    .insert(instanceSettings)
    .values({ key, value: json, updatedAt: ts, updatedBy })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: json, updatedAt: ts, updatedBy },
    });
  await writeAudit(s, {
    workspaceId: null,
    action: 'settings.updated',
    actor,
    targetType: 'settings',
    targetId: key,
    data: { keys: [key] },
  });
}
