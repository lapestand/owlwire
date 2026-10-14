import { newId } from '@owlwire/core';
import { getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from './__test__/env.js';
import { authAdapter, authSchema } from './auth-adapter.js';

let env: DbTestEnv;

beforeAll(async () => {
  env = await setupDbTestEnv();
}, 120_000);
afterAll(async () => {
  await env?.stop();
});

/** The model names the server's Better Auth configuration uses; each must be a key of authSchema. */
const OPTIONS = {
  user: {
    modelName: 'auth_user',
    additionalFields: { isInstanceAdmin: { type: 'boolean' as const } },
  },
  session: { modelName: 'auth_session' },
  account: { modelName: 'auth_account' },
  verification: { modelName: 'auth_verification' },
  advanced: { database: { generateId: () => newId() } },
};

interface UserRecord {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

describe('authAdapter', () => {
  it('keys every auth table by its own table name', () => {
    for (const [key, table] of Object.entries(authSchema))
      expect(getTableName(table), key).toBe(key);
  });

  it('writes and reads auth_user as the app role, outside any tenant or system scope', async () => {
    const adapter = authAdapter(env.db)(OPTIONS);
    const email = `adapter-${newId()}@x.test`;
    const created = await adapter.create<UserRecord>({
      model: 'user',
      data: {
        name: 'Adapter',
        email,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(created.email).toBe(email);
    const found = await adapter.findOne<{ id: string; isInstanceAdmin: boolean }>({
      model: 'user',
      where: [{ field: 'email', value: email }],
    });
    expect(found).toMatchObject({ id: created.id, isInstanceAdmin: false });
    const { rows } = await env.owner.query('select email from auth_user where id = $1', [
      created.id,
    ]);
    expect(rows).toEqual([{ email }]);
  });
});
