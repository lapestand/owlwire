import { newId } from '@owlwire/core';
import { twoFactor } from 'better-auth/plugins';
import { getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_TABLES } from './__test__/auth-tables.js';
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
  plugins: [twoFactor({ schema: { twoFactor: { modelName: 'auth_two_factor' } } })],
};

interface UserRecord {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface TwoFactorRecord {
  id: string;
  userId: string;
  secret: string;
  backupCodes: string;
  verified: boolean;
}

const adapter = () => authAdapter(env.db)(OPTIONS);

async function createUser(): Promise<UserRecord> {
  const now = new Date();
  return adapter().create<UserRecord>({
    model: 'user',
    data: {
      name: 'Adapter',
      email: `adapter-${newId()}@x.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    },
  });
}

describe('authAdapter', () => {
  it('keys every auth table by its own table name', () => {
    expect(Object.keys(authSchema).sort()).toEqual([...AUTH_TABLES].sort());
    for (const [key, table] of Object.entries(authSchema)) {
      expect(getTableName(table), key).toBe(key);
    }
  });

  it('writes and reads auth_user as the app role, outside any tenant or system scope', async () => {
    const created = await createUser();
    const found = await adapter().findOne<{ id: string; isInstanceAdmin: boolean }>({
      model: 'user',
      where: [{ field: 'email', value: created.email }],
    });
    expect(found).toMatchObject({ id: created.id, isInstanceAdmin: false });
    const { rows } = await env.owner.query('select email from auth_user where id = $1', [
      created.id,
    ]);
    expect(rows).toEqual([{ email: created.email }]);
  });

  it('keeps one two-factor row per user the way the plugin writes it (find, then update)', async () => {
    const user = await createUser();
    const data = { userId: user.id, secret: 'enc-1', backupCodes: 'enc-codes', verified: false };
    const first = await adapter().create<TwoFactorRecord>({ model: 'twoFactor', data });
    await adapter().update({
      model: 'twoFactor',
      where: [{ field: 'userId', value: user.id }],
      update: { secret: 'enc-2' },
    });
    const found = await adapter().findOne<TwoFactorRecord>({
      model: 'twoFactor',
      where: [{ field: 'userId', value: user.id }],
    });
    expect(found).toMatchObject({ id: first.id, secret: 'enc-2', verified: false });
    await expect(adapter().create({ model: 'twoFactor', data })).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'auth_two_factor_user_id_unique' },
    });
  });
});
