import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

export const POSTGRES_IMAGE = 'postgres:18-alpine';

export interface StartedPostgres {
  url: string;
  stop(): Promise<void>;
}

export async function startPostgres(image: string = POSTGRES_IMAGE): Promise<StartedPostgres> {
  const container = await new PostgreSqlContainer(image).start();
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
  await withAdmin(adminUrl, (c) => c.query(`create database ${name}`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      await withAdmin(adminUrl, (c) => c.query(`drop database if exists ${name} with (force)`));
    },
  };
}
