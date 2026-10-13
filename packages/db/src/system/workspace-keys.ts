import { DecryptError, rewrapWorkspaceDek, UnknownKekVersionError } from '@owlwire/crypto';
import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { RepoNotFoundError, safeErrorMessage } from '../errors.js';
import { dbInternals, type OwlwireDb } from '../handle.js';
import { type AuditActor, SYSTEM_ACTOR, writeAudit } from '../repos/audit.js';
import { keyringOf, now, q } from '../repos/context.js';
import { insertWorkspaceKey } from '../repos/workspace-keys.js';
import { workspaceKeys, workspaces } from '../schema/index.js';
import { type SystemScope, type TenantTx, tenantScope, withSystem, withTenant } from '../scope.js';

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

export interface RotateOptions {
  batchSize?: number;
  /** Her başarılı satır commit edildikten sonra çağrılır (ilerleme raporu; testlerde kesinti simülasyonu). */
  onRotated?: (workspaceId: string) => void | Promise<void>;
}

export interface RotateResult {
  currentVersion: number;
  rotated: number;
  failed: Array<{ workspaceId: string; error: string }>;
  /**
   * Çalışma sonunda güncel sürüm dışında kalan anahtarlar: sürüm → adet (güncelden yüksek sürümler dahil; onlar
   * hiç çevrilmez). Boşsa workspace anahtarları açısından OWLWIRE_KEK_PREVIOUS kaldırılabilir.
   */
  remainingByVersion: Map<number, number>;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Paket içi: sürümü bilinen bir KEK sarılı DEK'i açamadı (yanlış anahtar ya da bozuk satır). */
class WrongKekError extends Error {
  constructor(readonly kekVersion: number) {
    super(`KEK v${kekVersion} does not open the wrapped workspace key`);
    this.name = 'WrongKekError';
  }
}

/**
 * `failed[].error`: yalnız hata adı ve KEK sürümleri. Kripto hataları sabit metinlere indirgenir; geri kalanlar
 * (sorgu/bağlantı hataları) safeErrorMessage'dan geçer, sorgu parametreleri (sarılı DEK) atılır.
 */
function rotateFailureReason(err: unknown): string {
  if (err instanceof UnknownKekVersionError && Number.isInteger(err.kekVersion)) {
    return `UnknownKekVersionError: no KEK with version ${err.kekVersion}; set OWLWIRE_KEK_PREVIOUS`;
  }
  if (err instanceof WrongKekError) {
    return `DecryptError: KEK v${err.kekVersion} does not open the wrapped workspace key`;
  }
  if (err instanceof DecryptError) return 'DecryptError: wrapped workspace key could not be opened';
  return safeErrorMessage(err);
}

/**
 * Tek workspace'in anahtarını kilitler ve hâlâ güncel sürümde değilse güncel KEK ile yeniden sarar (DEK değişmez,
 * rewrapWorkspaceDek açık DEK'i sıfırlar); aynı transaction'da `keys.kek_rotated` denetimi (yalnız sürümler) yazılır.
 * Satır kaybolmuşsa (workspace silinmiş) ya da başka bir çalıştırma çevirmişse false döner.
 */
async function rotateOne(t: TenantTx, currentVersion: number): Promise<boolean> {
  const where = eq(workspaceKeys.workspaceId, t.workspaceId);
  const locked = await q(t)
    .select({ wrappedDek: workspaceKeys.wrappedDek, kekVersion: workspaceKeys.kekVersion })
    .from(workspaceKeys)
    .where(where)
    .for('update');
  const row = locked[0];
  // Yalnız eski sürümler çevrilir; güncelden yüksek sürüm (OWLWIRE_KEK ile PREVIOUS yer değiştirmiş) düşürülmez.
  if (!row || row.kekVersion >= currentVersion) return false;
  let next: { wrapped: Buffer; kekVersion: number };
  try {
    next = rewrapWorkspaceDek(keyringOf(t), row.wrappedDek, row.kekVersion, t.workspaceId);
  } catch (err) {
    if (err instanceof DecryptError) throw new WrongKekError(row.kekVersion);
    throw err;
  }
  await q(t)
    .update(workspaceKeys)
    .set({ wrappedDek: next.wrapped, kekVersion: next.kekVersion, rotatedAt: now(t) })
    .where(where);
  await writeAudit(t, {
    action: 'keys.kek_rotated',
    actor: SYSTEM_ACTOR,
    targetType: 'keys',
    targetId: t.workspaceId,
    data: { fromVersion: row.kekVersion, toVersion: next.kekVersion },
  });
  return true;
}

/**
 * Güncel KEK'ten DÜŞÜK sürümle sarılı bütün workspace DEK'lerini güncel KEK ile yeniden sarar (veri yeniden
 * şifrelenmez). Sürüm düşürme yapılmaz: güncelden yüksek sürümdeki anahtarlar (OWLWIRE_KEK ile OWLWIRE_KEK_PREVIOUS
 * yer değiştirmiş ya da yarım geri alınmış yapılandırma) olduğu gibi kalır ve `remainingByVersion`'da görünür;
 * çağıran bunu yapılandırma hatası saymalıdır. Kapsamlar iç içe açılamaz: kimlikler sistem transaction'ında sayfa sayfa listelenir, her workspace
 * kendi kiracı transaction'ında FOR UPDATE ile kilitlenip sürümü kilit altında yeniden denetlenerek çevrilir.
 * Bu yüzden idempotenttir, kesilirse yeniden çalıştırma kaldığı yerden bitirir, eşzamanlı iki çalıştırma aynı
 * satırı iki kez çevirmez. Soft-delete edilmiş workspace'ler bilerek dahildir (sırları çözülebilir kalmalı);
 * listelemeden sonra silinen workspace atlanır. Bir workspace'in hatası diğerlerini durdurmaz; `failed[].error`
 * yalnız hata adı ve sürüm taşır. `onRotated` hatası yayılır (çalıştırma durur, yeniden çalıştırma devam eder).
 */
export async function rotateWorkspaceKeys(
  scope: SystemScope,
  db: OwlwireDb,
  opts: RotateOptions = {},
): Promise<RotateResult> {
  const currentVersion = dbInternals(db).keyring.current.version;
  const batchSize = opts.batchSize ?? 100;
  let rotated = 0;
  const failed: RotateResult['failed'] = [];
  let after = ZERO_UUID;

  for (;;) {
    const batch = await withSystem(db, scope, (s) =>
      q(s)
        .select({ workspaceId: workspaceKeys.workspaceId })
        .from(workspaceKeys)
        .where(
          and(lt(workspaceKeys.kekVersion, currentVersion), gt(workspaceKeys.workspaceId, after)),
        )
        .orderBy(asc(workspaceKeys.workspaceId))
        .limit(batchSize),
    );
    if (batch.length === 0) break;
    for (const { workspaceId } of batch) {
      after = workspaceId;
      let changed = false;
      try {
        changed = await withTenant(db, tenantScope(workspaceId), (t) =>
          rotateOne(t, currentVersion),
        );
      } catch (err) {
        failed.push({ workspaceId, error: rotateFailureReason(err) });
      }
      if (changed) {
        rotated++;
        await opts.onRotated?.(workspaceId);
      }
    }
  }

  const remainingByVersion = await countKeysByVersion(scope, db);
  remainingByVersion.delete(currentVersion);
  return { currentVersion, rotated, failed, remainingByVersion };
}
