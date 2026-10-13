import { createSecretBox, DecryptError, type Keyring } from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import {
  backfillWorkspaceKeys,
  type LegacyDecrypt,
  type LegacyUpgradeResult,
  SYSTEM,
  upgradeLegacyConnectionSecrets,
} from '@owlwire/db/system';
import type { Logger } from 'pino';

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
    } catch {
      throw new DecryptError(
        'legacy connection config could not be decrypted with OWLWIRE_KEK or OWLWIRE_KEK_PREVIOUS',
      );
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
  if (keysCreated > 0 || result.upgraded > 0 || result.failed.length > 0) {
    logger.info(
      { keysCreated, upgraded: result.upgraded, failed: result.failed.length },
      'legacy secrets upgraded to workspace keys',
    );
  }
  for (const f of result.failed) {
    logger.error(
      { connectionId: f.connectionId, error: f.error },
      'legacy connection secret could not be upgraded',
    );
  }
  return { keysCreated, ...result };
}
