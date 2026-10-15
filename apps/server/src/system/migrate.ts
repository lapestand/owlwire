import { type AppRoleMode, migrateAll } from '@owlwire/db/migrate';
import type { Logger } from 'pino';
import type { ServerConfig } from '../config/load.js';

/**
 * Drizzle and Graphile Worker migrations, the application role and the auth role, all as the owner role and under the
 * advisory lock. The owner role is OWLWIRE_MIGRATION_DATABASE_URL, or OWLWIRE_DATABASE_URL without it ('same' mode).
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
