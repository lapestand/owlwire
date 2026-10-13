import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

/** R52: test Postgres imajının tek kaynağı; Spec §4.3'ün desteklenen en düşük ana sürümü (Görev 0 V15). */
export const POSTGRES_IMAGE = 'postgres:18-alpine';

export interface StartedPostgres {
  url: string;
  stop(): Promise<void>;
}

export async function startPostgres(
  image: string = POSTGRES_IMAGE,
  credentials?: { user: string; password: string },
): Promise<StartedPostgres> {
  let builder = new PostgreSqlContainer(image);
  if (credentials)
    builder = builder.withUsername(credentials.user).withPassword(credentials.password);
  const container = await builder.start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

export interface ScratchDatabase {
  url: string;
  drop(): Promise<void>;
}

async function withAdmin<T>(adminUrl: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(adminUrl: string): Promise<ScratchDatabase> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  await withAdmin(adminUrl, (c) =>
    // biome-ignore lint/plugin: identifier escaped with escapeIdentifier (R123)
    c.query(`create database ${c.escapeIdentifier(name)}`),
  );
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      await withAdmin(adminUrl, (c) =>
        // biome-ignore lint/plugin: identifier escaped with escapeIdentifier (R123)
        c.query(`drop database if exists ${c.escapeIdentifier(name)} with (force)`),
      );
    },
  };
}
