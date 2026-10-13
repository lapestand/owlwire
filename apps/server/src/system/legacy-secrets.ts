import {
  createSecretBox,
  DecryptError,
  type Keyring,
  UnknownKekVersionError,
} from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import {
  backfillWorkspaceKeys,
  type LegacyDecrypt,
  type LegacyUpgradeResult,
  SYSTEM,
  upgradeLegacyConnectionSecrets,
} from '@owlwire/db/system';
import type { Logger } from 'pino';

/** SecretBox'ın yapısal denetimlerinden gelen sabit, içerik taşımayan mesajlar (envelope.ts). */
const SAFE_BOX_MESSAGES = new Set([
  'unknown secret box format',
  'secret box is truncated',
  'unknown wrapped DEK format',
  'unknown ciphertext format',
]);
/** envelope.ts unwrapDek: `no KEK available for KEK version <n>`; yalnız sayı yakalanır. */
const MISSING_KEK = /^no KEK available for KEK version (\d{1,5})$/;

/**
 * Bilinen, sır içermeyen hatalar korunur (eksik KEK sürümü UnknownKekVersionError olur, operatöre hangi
 * OWLWIRE_KEK_PREVIOUS gerektiğini söyler); geri kalan her şey (AEAD, JSON.parse gibi düz metni yankılayabilen
 * hatalar) sabit genel mesaja indirgenir. `cause` taşınmaz.
 */
function sanitizeOpenError(err: unknown): Error {
  if (err instanceof UnknownKekVersionError) return new UnknownKekVersionError(err.kekVersion);
  if (err instanceof Error && err.constructor === Error) {
    const missing = MISSING_KEK.exec(err.message);
    if (missing?.[1]) return new UnknownKekVersionError(Number(missing[1]));
    if (SAFE_BOX_MESSAGES.has(err.message)) return new DecryptError(err.message);
  }
  return new DecryptError(
    'legacy connection config could not be decrypted with OWLWIRE_KEK or OWLWIRE_KEK_PREVIOUS',
  );
}

/**
 * P0 biçimi SecretBox'tır (0x02; V6, Sözleşme §6.2 kek_v0). SecretBox sarılı DEK başlığındaki sürüme göre
 * güncel ya da önceki KEK'i seçer (R90). Hata mesajı içerik taşımaz.
 */
export function legacyDecryptor(keyring: Keyring): LegacyDecrypt {
  const box = createSecretBox(keyring);
  return (ciphertext) => {
    let value: unknown;
    try {
      value = box.open<unknown>(Buffer.from(ciphertext));
    } catch (err) {
      throw sanitizeOpenError(err);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new DecryptError('legacy connection config is not a JSON object');
    }
    return value as Record<string, unknown>;
  };
}

export async function upgradeLegacySecrets(
  db: OwlwireDb,
  keyring: Keyring,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<{ keysCreated: number } & LegacyUpgradeResult> {
  const keysCreated = await backfillWorkspaceKeys(SYSTEM, db);
  const result = await upgradeLegacyConnectionSecrets(SYSTEM, db, legacyDecryptor(keyring));
  // Yalnız sayılar ve bağlantı kimlikleri loglanır; f.error safeErrorMessage'dır (config ya da sorgu parametresi yok).
  const counts = { keysCreated, upgraded: result.upgraded, failed: result.failed.length };
  if (result.upgraded === 0 && result.failed.length > 0) {
    logger.info(counts, 'legacy secret upgrade finished with failures');
  } else if (keysCreated > 0 || result.upgraded > 0) {
    logger.info(counts, 'legacy secrets upgraded to workspace keys');
  }
  for (const f of result.failed) {
    logger.error(
      { connectionId: f.connectionId, error: f.error },
      'legacy connection secret could not be upgraded',
    );
  }
  return { keysCreated, ...result };
}
