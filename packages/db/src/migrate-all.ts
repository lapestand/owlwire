import { runMigrations as runGraphileMigrations } from 'graphile-worker';
import pg from 'pg';
import { runMigrations } from './migrate.js';
import { type AppRoleMode, ensureAppRole } from './roles.js';

export interface MigrateAllOptions {
  ownerUrl: string;
  appUrl: string;
}

/**
 * Bütün şema değişikliklerini sahip rolüyle uygular, ardından uygulama rolünü oluşturur ve yetkilerini verir.
 * runMigrations MIGRATION_LOCK_KEY advisory lock'unu alır; afterMigrate aynı kilit altında çalıştığı için
 * Drizzle, Graphile Worker şeması ve ensureAppRole tek kilit altında sıralanır.
 */
export async function migrateAll(opts: MigrateAllOptions): Promise<{ appRole: AppRoleMode }> {
  const ownerPool = new pg.Pool({ connectionString: opts.ownerUrl, max: 3 });
  // Bağlantı hatası (ör. sunucu yeniden başladı) süreci düşürmesin; hata, o bağlantıyı kullanan sorguda
  // yüzeye çıkar. Graphile Worker her iki dinleyiciyi de ister, yoksa uyarı basar.
  const ignore = () => {};
  ownerPool.on('error', ignore);
  ownerPool.on('connect', (client) => client.on('error', ignore));
  let appRole: AppRoleMode | undefined;
  try {
    await runMigrations(ownerPool, {
      afterMigrate: async () => {
        await runGraphileMigrations({ pgPool: ownerPool });
        appRole = await ensureAppRole(opts.ownerUrl, opts.appUrl);
      },
    });
  } finally {
    await ownerPool.end();
  }
  if (appRole === undefined) throw new Error('migrateAll: afterMigrate did not run');
  return { appRole };
}

export { AppRoleError, type AppRoleMode, ensureAppRole } from './roles.js';
