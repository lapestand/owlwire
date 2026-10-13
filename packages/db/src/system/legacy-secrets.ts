import { ZERO_UUID } from '@owlwire/core';
import { DecryptError, UnknownKekVersionError } from '@owlwire/crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { LegacyDecryptFailedError, safeErrorMessage } from '../errors.js';
import type { OwlwireDb } from '../handle.js';
import { SYSTEM_ACTOR, writeAudit } from '../repos/audit.js';
import { sealConnectionConfig } from '../repos/connection-crypto.js';
import { now, q } from '../repos/context.js';
import { connections } from '../schema/index.js';
import { type SystemScope, type TenantTx, tenantScope, withSystem, withTenant } from '../scope.js';

/** P0 `config_enc` (kek_v0) çözücüsü; P0 şifreleme biçimi `@owlwire/db`'ye sızmasın diye dışarıdan verilir. */
export type LegacyDecrypt = (ciphertext: Uint8Array) => Record<string, unknown>;

export interface LegacyUpgradeResult {
  upgraded: number;
  /** `missingKekVersion`: yalnız KEK sürümü yapılandırılmadığı için açılamayan satırlarda dolu. */
  failed: Array<{ connectionId: string; error: string; missingKekVersion?: number }>;
}

/**
 * Çözücü hatasından yalnız izin listesindeki, içerik taşımayan gerekçe türetilir. Hata mesajı asla kopyalanmaz:
 * ör. `JSON.parse` SyntaxError'ı düz metni yankılar.
 */
function legacyDecryptFailureReason(err: unknown): string {
  if (err instanceof UnknownKekVersionError && Number.isInteger(err.kekVersion)) {
    return `no KEK with version ${err.kekVersion}; set OWLWIRE_KEK_PREVIOUS`;
  }
  if (err instanceof DecryptError) return 'DecryptError';
  if (err instanceof SyntaxError) return 'invalid JSON';
  return 'unrecognised decryptor error';
}

function decryptOrFail(
  decryptLegacy: LegacyDecrypt,
  ciphertext: Uint8Array,
): Record<string, unknown> {
  try {
    return decryptLegacy(ciphertext);
  } catch (err) {
    const missing =
      err instanceof UnknownKekVersionError && Number.isInteger(err.kekVersion)
        ? err.kekVersion
        : undefined;
    throw new LegacyDecryptFailedError(legacyDecryptFailureReason(err), missing);
  }
}

const BATCH = 100;

/**
 * Tek bağlantıyı kilitler ve hâlâ `kek_v0` ise workspace DEK'iyle yeniden mühürler. Satır kaybolmuşsa ya da
 * başka bir çalıştırma dönüştürmüşse false döner. Çözülmüş config yalnız bu fonksiyonun içinde yaşar.
 */
async function upgradeOne(
  t: TenantTx,
  connectionId: string,
  decryptLegacy: LegacyDecrypt,
): Promise<boolean> {
  // Soft-delete edilmiş satırlar bilerek dahildir (byId'deki deleted_at filtresi yok): sırları geri yükleme
  // ve temizlik için çözülebilir kalmalıdır.
  const where = and(eq(connections.workspaceId, t.workspaceId), eq(connections.id, connectionId));
  const locked = await q(t)
    .select({ configEnc: connections.configEnc, configEncScheme: connections.configEncScheme })
    .from(connections)
    .where(where)
    .for('update');
  const current = locked[0];
  if (current?.configEncScheme !== 'kek_v0') return false;
  const sealed =
    current.configEnc === null
      ? null
      : await sealConnectionConfig(
          t,
          connectionId,
          decryptOrFail(decryptLegacy, current.configEnc),
        );
  await q(t)
    .update(connections)
    .set({ configEnc: sealed, configEncScheme: 'dek_v1', updatedAt: now(t) })
    .where(where);
  return true;
}

/**
 * `config_enc_scheme = 'kek_v0'` satırlarını workspace DEK'iyle yeniden şifreler (AAD connectionConfigAad).
 * Kapsamlar iç içe açılamaz: kimlikler sistem transaction'ında sayfa sayfa listelenir, her satır kendi kiracı
 * transaction'ında FOR UPDATE ile kilitlenip şema yeniden denetlenerek dönüştürülür; idempotent ve eşzamanlı
 * çalıştırmaya dayanıklıdır. Bir satırın hatası diğerlerini durdurmaz; `failed[].error` safeErrorMessage'dır,
 * çözücü hataları sabit `LegacyDecryptFailedError`'a sarılır, böylece çözülmüş içerik, şifreli metin ya da
 * sorgu parametresi taşımaz. En az bir satır dönüştüyse tek bir instance düzeyi `keys.legacy_secrets_upgraded`
 * denetim kaydı (yalnız sayılar, `failed` dahil) yazılır; yalnız başarısızlık içeren çalıştırma hiçbir şeyi
 * değiştirmediği için denetime girmez, loglarla raporlanır.
 */
export async function upgradeLegacyConnectionSecrets(
  scope: SystemScope,
  db: OwlwireDb,
  decryptLegacy: LegacyDecrypt,
): Promise<LegacyUpgradeResult> {
  const result: LegacyUpgradeResult = { upgraded: 0, failed: [] };
  let after = ZERO_UUID;
  for (;;) {
    const batch = await withSystem(db, scope, (s) =>
      q(s)
        .select({ id: connections.id, workspaceId: connections.workspaceId })
        .from(connections)
        .where(and(eq(connections.configEncScheme, 'kek_v0'), gt(connections.id, after)))
        .orderBy(asc(connections.id))
        .limit(BATCH),
    );
    if (batch.length === 0) break;
    for (const row of batch) {
      after = row.id;
      try {
        const changed = await withTenant(db, tenantScope(row.workspaceId), (t) =>
          upgradeOne(t, row.id, decryptLegacy),
        );
        if (changed) result.upgraded++;
      } catch (err) {
        result.failed.push({
          connectionId: row.id,
          error: safeErrorMessage(err),
          ...(err instanceof LegacyDecryptFailedError && err.missingKekVersion !== undefined
            ? { missingKekVersion: err.missingKekVersion }
            : {}),
        });
      }
    }
  }
  if (result.upgraded > 0) {
    await withSystem(db, scope, (s) =>
      writeAudit(s, {
        workspaceId: null,
        action: 'keys.legacy_secrets_upgraded',
        actor: SYSTEM_ACTOR,
        targetType: 'keys',
        targetId: 'connections',
        data: { upgraded: result.upgraded, failed: result.failed.length },
      }),
    );
  }
  return result;
}

/** Hâlâ P0 biçiminde (`kek_v0`, KEK ile doğrudan mühürlü) duran bağlantı sırrı sayısı; soft-delete edilmişler dahil. */
export async function countLegacyConnectionSecrets(
  scope: SystemScope,
  db: OwlwireDb,
): Promise<number> {
  const rows = await withSystem(db, scope, (s) =>
    q(s)
      .select({ n: sql<number>`count(*)::int` })
      .from(connections)
      .where(eq(connections.configEncScheme, 'kek_v0')),
  );
  return rows[0]?.n ?? 0;
}
