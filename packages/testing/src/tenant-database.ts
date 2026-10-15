import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pgAdminUrl } from './context.js';
import { createTestDatabase, POSTGRES_IMAGE } from './postgres.js';
import { TEST_APP, TEST_AUTH, TEST_OWNER } from './test-roles.js';

export { TEST_APP, TEST_AUTH, TEST_OWNER } from './test-roles.js';

export interface TestDatabase {
  readonly ownerUrl: string;
  readonly appUrl: string;
  /** The auth role (owlwire_auth): the only role with access to the auth tables' secrets. */
  readonly authUrl: string;
  stop(): Promise<void>;
}

export interface TestDatabaseUrls {
  ownerUrl: string;
  appUrl: string;
  authUrl: string;
}

export interface StartTestDatabaseOptions {
  migrate(urls: TestDatabaseUrls): Promise<unknown>;
}

/** int projesinin global-setup'ı pgAdminUrl sağlamışsa onu döndürür; yoksa (tek dosya çalıştırma) undefined. */
function injectedAdminUrl(): string | undefined {
  try {
    return pgAdminUrl() || undefined;
  } catch {
    return undefined;
  }
}

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}

async function migrateOrCleanup(
  opts: StartTestDatabaseOptions,
  urls: TestDatabaseUrls,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await opts.migrate(urls);
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Three-role test database (owner, application role, auth role). In the `int` project it opens a fresh database in the
 * global container; without global-setup it starts its own container. Image: OWLWIRE_TEST_PG_IMAGE ?? POSTGRES_IMAGE.
 */
export async function startTestDatabase(opts: StartTestDatabaseOptions): Promise<TestDatabase> {
  const adminUrl = injectedAdminUrl();
  if (adminUrl) {
    if (decodeURIComponent(new URL(adminUrl).username) !== TEST_OWNER.user) {
      throw new Error(`global-setup must start Postgres as ${TEST_OWNER.user} (TEST_OWNER)`);
    }
    const scratch = await createTestDatabase(adminUrl);
    const urls = {
      ownerUrl: scratch.url,
      appUrl: withCredentials(scratch.url, TEST_APP.user, TEST_APP.password),
      authUrl: withCredentials(scratch.url, TEST_AUTH.user, TEST_AUTH.password),
    };
    await migrateOrCleanup(opts, urls, () => scratch.drop());
    return { ...urls, stop: () => scratch.drop() };
  }

  const container = await new PostgreSqlContainer(
    process.env.OWLWIRE_TEST_PG_IMAGE ?? POSTGRES_IMAGE,
  )
    .withDatabase('owlwire')
    .withUsername(TEST_OWNER.user)
    .withPassword(TEST_OWNER.password)
    .start();
  const ownerUrl = container.getConnectionUri();
  const urls = {
    ownerUrl,
    appUrl: withCredentials(ownerUrl, TEST_APP.user, TEST_APP.password),
    authUrl: withCredentials(ownerUrl, TEST_AUTH.user, TEST_AUTH.password),
  };
  const stop = async () => {
    await container.stop();
  };
  await migrateOrCleanup(opts, urls, stop);
  return { ...urls, stop };
}
