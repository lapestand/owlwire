import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

/** Test Postgres imajının tek kaynağı; desteklenen en düşük PostgreSQL ana sürümü. */
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

/** 55006: the database is still being accessed by other users. */
const OBJECT_IN_USE = '55006';

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
    // biome-ignore lint/plugin: identifier escaped with escapeIdentifier
    c.query(`create database ${c.escapeIdentifier(name)}`),
  );
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      await withAdmin(adminUrl, async (c) => {
        const db = c.escapeIdentifier(name);
        try {
          // pg-pool's end() resolves before its sockets close, so the server may still be serving
          // sessions that are already on their way out. A plain drop waits (up to 5 s) for them;
          // FORCE would terminate them with 57P01, which an idle pg client emits as 'error'.
          // biome-ignore lint/plugin: identifier escaped with escapeIdentifier
          await c.query(`drop database if exists ${db}`);
        } catch (err) {
          if ((err as { code?: unknown }).code !== OBJECT_IN_USE) throw err;
          // A session that never ended: drop anyway so the scratch database does not leak.
          // biome-ignore lint/plugin: identifier escaped with escapeIdentifier
          await c.query(`drop database if exists ${db} with (force)`);
        }
      });
    },
  };
}
