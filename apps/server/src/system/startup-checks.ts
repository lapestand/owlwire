import type { OwlwireDb } from '@owlwire/db';
import {
  assertKeyringCoversKeys,
  checkRlsEnforcement,
  RlsNotEnforcedError,
  SYSTEM,
} from '@owlwire/db/system';

export interface StartupCheckOptions {
  /** process.env.NODE_ENV; yalnız 'development' RLS uygulanmayan bağlantıda açılışa (uyarıyla) izin verir. */
  nodeEnv?: string | undefined;
  logger?: { warn(obj: { reasons: string[] }, msg: string): void };
}

/**
 * serve açılışında çağrılır (Sözleşme §4, §11.2). Uygulama bağlantısı RLS'i aşabiliyorsa (süper kullanıcı, BYPASSRLS,
 * tablo sahibi — ör. OWLWIRE_MIGRATION_DATABASE_URL verilmemiş 'same' modu) süreç başlamaz; yalnız
 * NODE_ENV=development yerel geliştirmede uyarıyla devam eder. Varsayılan katıdır (NODE_ENV yoksa da reddeder).
 * Anahtarlık saklı bir KEK sürümünü kapsamıyorsa her ortamda reddeder.
 */
export async function runStartupChecks(
  db: OwlwireDb,
  opts: StartupCheckOptions = {},
): Promise<void> {
  const rls = await checkRlsEnforcement(SYSTEM, db);
  if (!rls.enforced) {
    if (opts.nodeEnv !== 'development') throw new RlsNotEnforcedError(rls.reasons);
    opts.logger?.warn(
      { reasons: rls.reasons },
      'row level security is NOT enforced for the application database role; allowed only because NODE_ENV=development',
    );
  }
  await assertKeyringCoversKeys(SYSTEM, db);
}
