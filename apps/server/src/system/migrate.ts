import { type AppRoleMode, migrateAll } from '@owlwire/db/migrate';
import type { Logger } from 'pino';
import type { ServerConfig } from '../config/load.js';

/**
 * Drizzle + Graphile Worker migration'ları, uygulama rolü ve auth rolü; hepsi sahip rolüyle ve advisory lock altında.
 * Sahip rolü OWLWIRE_MIGRATION_DATABASE_URL'dir; yoksa OWLWIRE_DATABASE_URL kullanılır ('same' modu).
 */
export async function migrateDatabase(
  config: Pick<ServerConfig, 'databaseUrl' | 'migrationDatabaseUrl' | 'authDatabaseUrl'>,
  logger: Pick<Logger, 'info' | 'warn'>,
): Promise<AppRoleMode> {
  const ownerUrl = config.migrationDatabaseUrl ?? config.databaseUrl;
  const { appRole, authRole } = await migrateAll({
    ownerUrl,
    appUrl: config.databaseUrl,
    authUrl: config.authDatabaseUrl,
  });
  if (authRole !== 'separate') {
    logger.warn(
      authRole === 'none'
        ? 'OWLWIRE_AUTH_DATABASE_URL is not set; the auth role was not provisioned and `serve` will refuse to start ' +
            '(local development only: OWLWIRE_ALLOW_INSECURE_DB_ROLE=true outside NODE_ENV=production)'
        : 'OWLWIRE_AUTH_DATABASE_URL uses the owner role; sessions and credentials are not separated from it',
    );
  }
  if (appRole === 'same') {
    logger.warn(
      'OWLWIRE_MIGRATION_DATABASE_URL is not set or uses the same role as OWLWIRE_DATABASE_URL; ' +
        'row level security cannot be enforced and `serve` will refuse to start ' +
        '(local development only: OWLWIRE_ALLOW_INSECURE_DB_ROLE=true outside NODE_ENV=production)',
    );
  } else {
    logger.info('database migrated; application role provisioned');
  }
  return appRole;
}
