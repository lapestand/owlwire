import { systemClock } from '@owlwire/core';
import { createKeyring, generateKek, generateToken, hashToken, tokenPrefix } from '@owlwire/crypto';
import {
  createApp,
  createInstallation,
  getConnection,
  insertEvent,
  type OwlwireDb,
  openDatabase,
  readConnectionConfig,
  revokeInstallation,
  SYSTEM_ACTOR,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import { migrateAll } from '@owlwire/db/migrate';
import { KeyringCoverageError, RlsNotEnforcedError } from '@owlwire/db/system';
import { startTestDatabase, type TestDatabase } from '@owlwire/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSeedResult, seedDevWorkspace } from './dev-seed.js';
import { authenticateInstallationToken } from './installation-auth.js';
import { migrateDatabase } from './migrate.js';
import { runStartupChecks } from './startup-checks.js';
import { resolveTenant } from './tenant-resolver.js';

let tdb: TestDatabase;
let db: OwlwireDb;
let owner: pg.Pool;
const keyring = createKeyring(generateKek(1));
const opened: OwlwireDb[] = [];
const open = (url: string, k = keyring) => {
  const handle = openDatabase({ url, keyring: k, clock: systemClock });
  opened.push(handle);
  return handle;
};
const silent = { info: () => undefined, warn: () => undefined };

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  db = open(tdb.appUrl);
  owner = new pg.Pool({ connectionString: tdb.ownerUrl, max: 2 });
}, 120_000);

afterAll(async () => {
  for (const handle of opened) await handle.close();
  await owner?.end();
  await tdb?.stop();
});

describe('startup checks', () => {
  it('pass for the dedicated application role', async () => {
    await expect(runStartupChecks(db)).resolves.toBeUndefined();
  });

  it('refuse to start when the application connects as the table owner', async () => {
    const err = await runStartupChecks(open(tdb.ownerUrl)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RlsNotEnforcedError);
    expect((err as RlsNotEnforcedError).reasons.join(' ')).toMatch(/SUPERUSER|owns the tables/);
  });

  it('start with one warning per reason only with OWLWIRE_ALLOW_INSECURE_DB_ROLE outside production', async () => {
    const ownerDb = open(tdb.ownerUrl);
    // Without the opt-in: refused in every environment, development included.
    for (const nodeEnv of ['development', 'test', undefined]) {
      await expect(runStartupChecks(ownerDb, { nodeEnv, logger: silent })).rejects.toBeInstanceOf(
        RlsNotEnforcedError,
      );
    }
    // The opt-in is ignored in production.
    await expect(
      runStartupChecks(ownerDb, {
        allowInsecureDbRole: true,
        nodeEnv: 'production',
        logger: silent,
      }),
    ).rejects.toBeInstanceOf(RlsNotEnforcedError);
    const warnings: string[] = [];
    await expect(
      runStartupChecks(ownerDb, {
        allowInsecureDbRole: true,
        nodeEnv: 'development',
        logger: { warn: (obj: { reason: string }) => void warnings.push(obj.reason) },
      }),
    ).resolves.toBeUndefined();
    // The test owner is a superuser (with BYPASSRLS) that owns the tables: every reason, one warning each.
    expect(warnings).toEqual([
      'application role is SUPERUSER',
      'application role has BYPASSRLS',
      'application role owns the tables',
    ]);
  });

  it('refuse to start when a stored KEK version is missing from the keyring', async () => {
    await seedDevWorkspace(db, { platform: 'telegram' });
    await expect(
      runStartupChecks(open(tdb.appUrl, createKeyring(generateKek(9)))),
    ).rejects.toBeInstanceOf(KeyringCoverageError);
  });

  it('refuse to start when a stored KEK version is configured with the wrong key material', async () => {
    await seedDevWorkspace(db, { platform: 'telegram' });
    const wrong = createKeyring(generateKek(1)); // same version 1, different key
    const err = await runStartupChecks(open(tdb.appUrl, wrong)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyringCoverageError);
    expect((err as KeyringCoverageError).missingVersions).toEqual([]);
    expect((err as KeyringCoverageError).mismatchedVersions).toEqual([1]);
    expect((err as Error).message).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  });
});

describe('migrateDatabase', () => {
  it('reports same-role mode and warns when no migration URL is given', async () => {
    const warnings: string[] = [];
    const mode = await migrateDatabase(
      { databaseUrl: tdb.ownerUrl },
      { ...silent, warn: (msg: string) => warnings.push(msg) },
    );
    expect(mode).toBe('same');
    expect(warnings.join(' ')).toContain('OWLWIRE_MIGRATION_DATABASE_URL');
  });

  it('uses the migration URL as owner when given', async () => {
    const mode = await migrateDatabase(
      { databaseUrl: tdb.appUrl, migrationDatabaseUrl: tdb.ownerUrl },
      silent,
    );
    expect(mode).toBe('separate');
  });
});

describe('seedDevWorkspace', () => {
  it('creates an own bot connection with an encrypted token when --bot-token is given', async () => {
    const r = await seedDevWorkspace(db, {
      platform: 'telegram',
      botToken: '123:abc',
      chatId: '-1001',
      name: 'Dev',
    });
    await withTenant(db, tenantScope(r.workspaceId), async (t) => {
      expect((await getConnection(t, r.connectionId))?.kind).toBe('own_bot');
      expect(await readConnectionConfig(t, r.connectionId, { purpose: 'send' })).toEqual({
        botToken: '123:abc',
      });
    });
    const { rows } = await owner.query<{ scheme: string }>(
      'select config_enc_scheme as scheme from connections where id = $1',
      [r.connectionId],
    );
    expect(rows[0]?.scheme).toBe('dek_v1');
    expect(r.destinationId).not.toBeNull();
    expect(formatSeedResult(r, { port: 8080, platform: 'telegram' })).toContain(r.token);
  });

  it('uses the shared bot (no config) without a token and the fake webhook adapter for webhook', async () => {
    const shared = await seedDevWorkspace(db, { platform: 'telegram' });
    const hook = await seedDevWorkspace(db, { platform: 'webhook', chatId: 'fake-destination' });
    await withTenant(db, tenantScope(shared.workspaceId), async (t) => {
      expect((await getConnection(t, shared.connectionId))?.kind).toBe('shared_bot');
      expect(await readConnectionConfig(t, shared.connectionId, { purpose: 'send' })).toBeNull();
    });
    expect(shared.destinationId).toBeNull();
    await withTenant(db, tenantScope(hook.workspaceId), async (t) => {
      expect(await getConnection(t, hook.connectionId)).toMatchObject({
        platform: 'webhook',
        kind: 'webhook',
        status: 'active',
      });
    });
  });
});

describe('installation auth and tenant resolution', () => {
  it('authenticates a token to its workspace, rejects unknown and revoked tokens', async () => {
    const seeded = await seedDevWorkspace(db, { platform: 'telegram' });
    const ok = await authenticateInstallationToken(db, seeded.token);
    expect(ok.ok && ok.installation.workspaceId).toBe(seeded.workspaceId);
    expect(await authenticateInstallationToken(db, generateToken('inst'))).toEqual({
      ok: false,
      code: 'unauthorized',
    });
    expect(await authenticateInstallationToken(db, 'not-a-token')).toEqual({
      ok: false,
      code: 'unauthorized',
    });

    const token = generateToken('inst');
    await withTenant(db, tenantScope(seeded.workspaceId), async (t) => {
      const app = await createApp(
        t,
        { name: 'r', slug: `revoked-${seeded.workspaceId}`, visibility: 'private' },
        SYSTEM_ACTOR,
      );
      const created = await createInstallation(
        t,
        { appId: app.id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) },
        SYSTEM_ACTOR,
      );
      await revokeInstallation(t, created.id, SYSTEM_ACTOR);
    });
    expect(await authenticateInstallationToken(db, token)).toEqual({
      ok: false,
      code: 'installation_revoked',
    });
  });

  it('resolves the tenant of an event id', async () => {
    const seeded = await seedDevWorkspace(db, { platform: 'telegram' });
    const { eventId } = await withTenant(db, tenantScope(seeded.workspaceId), (t) =>
      insertEvent(t, {
        installationId: seeded.installationId,
        idempotencyKey: 'resolve-1',
        type: 'generic',
        severity: 'info',
        message: { type: 'generic', severity: 'info', body: 'x' },
      }),
    );
    expect(await resolveTenant(db, 'event', eventId)).toEqual({
      workspaceId: seeded.workspaceId,
    });
    expect(await resolveTenant(db, 'event', '0192f0a0-0000-7000-8000-000000000000')).toBeNull();
  });
});
