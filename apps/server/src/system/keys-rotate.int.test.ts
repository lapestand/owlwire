import { randomUUID } from 'node:crypto';
import { systemClock } from '@owlwire/core';
import {
  createKeyring,
  createSecretBox,
  generateKek,
  type Kek,
  type Keyring,
} from '@owlwire/crypto';
import {
  type OwlwireDb,
  openDatabase,
  readConnectionConfig,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import { migrateAll } from '@owlwire/db/migrate';
import { startTestDatabase, type TestDatabase } from '@owlwire/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDevWorkspace } from './dev-seed.js';
import { runKeysRotate } from './keys-rotate.js';

let tdb: TestDatabase;
let owner: pg.Pool;
const v1 = generateKek(1);
const v2 = generateKek(2);
const v3 = generateKek(3);
const v4 = generateKek(4);
const opened: OwlwireDb[] = [];
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const b64 = (k: Kek): string => Buffer.from(k.key).toString('base64');

const open = (keyring: Keyring) => {
  const db = openDatabase({ url: tdb.appUrl, keyring, clock: systemClock });
  opened.push(db);
  return db;
};

async function run(keyring: Keyring): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await runKeysRotate({
    db: open(keyring),
    keyring,
    logger: silent,
    out: (l) => lines.push(l),
  });
  const out = lines.join('\n');
  for (const k of [v1, v2, v3, v4]) expect(out).not.toContain(b64(k));
  return { code, out };
}

async function versions(): Promise<Record<number, number>> {
  const { rows } = await owner.query<{ v: number; n: number }>(
    'select kek_version as v, count(*)::int as n from workspace_keys group by 1 order by 1',
  );
  return Object.fromEntries(rows.map((r) => [r.v, r.n]));
}

/** A fresh workspace (with its DEK wrapped by `kek`, and a dev-seed connection); returns its id. */
async function seedWorkspace(kek: Kek): Promise<string> {
  return (await seedDevWorkspace(open(createKeyring(kek)), { platform: 'telegram' })).workspaceId;
}

async function insertLegacySecret(workspaceId: string, kek: Kek, config: object): Promise<string> {
  const id = randomUUID();
  await owner.query(
    "insert into connections (id, workspace_id, platform, kind, display_name, config_enc, config_enc_scheme) values ($1, $2, 'telegram', 'own_bot', 'legacy', $3, 'kek_v0')",
    [id, workspaceId, createSecretBox(createKeyring(kek)).seal(config)],
  );
  return id;
}

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl });
}, 120_000);

afterAll(async () => {
  for (const db of opened) await db.close();
  await owner?.end();
  await tdb?.stop();
});

// Every test starts from an empty database and seeds its own workspaces and keys, so the tests pass in any order.
beforeEach(async () => {
  await owner.query('truncate workspaces, audit_log cascade');
});

describe('owlwire keys rotate', () => {
  it('reports nothing to do when keys are current', async () => {
    await seedWorkspace(v1);
    const r = await run(createKeyring(v1));
    expect(r.code).toBe(0);
    expect(r.out).toContain('already');
    expect(r.out).not.toContain('can be removed');
  });

  it('exits with 2 when stale keys exist but OWLWIRE_KEK_PREVIOUS is missing', async () => {
    await seedWorkspace(v1);
    const r = await run(createKeyring(v2));
    expect(r.code).toBe(2);
    expect(r.out).toContain('OWLWIRE_KEK_PREVIOUS');
    expect(r.out).toContain('v1: 1');
    expect(await versions()).toEqual({ 1: 1 });
  });

  it('exits with 2 when OWLWIRE_KEK_PREVIOUS holds the wrong key for its version', async () => {
    await seedWorkspace(v1);
    const r = await run(createKeyring(v2, generateKek(1)));
    expect(r.code).toBe(2);
    expect(r.out).toContain('does not open the stored workspace keys');
    expect(await versions()).toEqual({ 1: 1 });
  });

  it('upgrades P0 SecretBox secrets sealed with the old KEK, rotates, and says PREVIOUS can be removed', async () => {
    const workspaceId = await seedWorkspace(v1);
    const legacyConnectionId = await insertLegacySecret(workspaceId, v1, {
      botToken: 'legacy-token',
    });
    const r = await run(createKeyring(v2, v1));
    expect(r.code).toBe(0);
    expect(r.out).toContain('Re-wrapped 1 workspace key(s) with KEK v2');
    expect(r.out).toContain('OWLWIRE_KEK_PREVIOUS can be removed');
    expect(r.out).not.toContain('legacy-token');
    expect(await versions()).toEqual({ 2: 1 });
    const config = await withTenant(open(createKeyring(v2)), tenantScope(workspaceId), (t) =>
      readConnectionConfig(t, legacyConnectionId, { purpose: 'send' }),
    );
    expect(config).toEqual({ botToken: 'legacy-token' });
  });

  it('says PREVIOUS can be removed on a run that finds nothing to rotate', async () => {
    await seedWorkspace(v2);
    const r = await run(createKeyring(v2, v1));
    expect(r.code).toBe(0);
    expect(r.out).toContain('already');
    expect(r.out).toContain('OWLWIRE_KEK_PREVIOUS can be removed');
  });

  it('refuses to re-wrap newer keys down when OWLWIRE_KEK and OWLWIRE_KEK_PREVIOUS are swapped', async () => {
    await seedWorkspace(v2);
    const r = await run(createKeyring(v1, v2));
    expect(r.code).toBe(2);
    expect(r.out).toContain('v2 are newer than OWLWIRE_KEK_VERSION v1');
    expect(r.out).toContain('look swapped');
    expect(r.out).not.toContain('can be removed');
    expect(await versions()).toEqual({ 2: 1 });
    const { rows } = await owner.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'keys.kek_rotated'",
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('exits with 2 when a legacy secret is sealed with an unconfigured KEK version', async () => {
    const workspaceId = await seedWorkspace(v2);
    await insertLegacySecret(workspaceId, generateKek(9), { botToken: 'x' });
    const r = await run(createKeyring(v2));
    expect(r.code).toBe(2);
    expect(r.out).toContain('Legacy secrets are sealed with KEK v9');
    expect(r.out).toContain('OWLWIRE_KEK_PREVIOUS');
    expect(r.out).not.toContain('can be removed');
  });

  it('exits with 1 when a P0 secret appears during the run', async () => {
    await seedWorkspace(v2);
    // Simulates a still-running P0 process sealing a secret with the KEK while the rotation runs.
    await owner.query(`
      create function test_late_legacy() returns trigger language plpgsql as $$
      begin
        insert into connections (id, workspace_id, platform, kind, display_name, config_enc, config_enc_scheme)
        values (gen_random_uuid(), new.workspace_id, 'telegram', 'own_bot', 'late-p0', null, 'kek_v0');
        return new;
      end $$`);
    await owner.query(
      'create trigger test_late_legacy after update on workspace_keys for each row execute function test_late_legacy()',
    );
    let r: { code: number; out: string };
    try {
      r = await run(createKeyring(v3, v2));
    } finally {
      await owner.query('drop trigger test_late_legacy on workspace_keys');
      await owner.query('drop function test_late_legacy()');
    }
    expect(r.code).toBe(1);
    expect(r.out).toContain('Re-wrapped 1 workspace key(s) with KEK v3');
    expect(r.out).toContain('1 legacy connection secret(s) are still sealed directly with a KEK');
    expect(r.out).not.toContain('can be removed');
    // A re-run upgrades the late secret and finishes.
    const again = await run(createKeyring(v3, v2));
    expect(again.code).toBe(0);
    expect(again.out).toContain('OWLWIRE_KEK_PREVIOUS can be removed');
    expect(await versions()).toEqual({ 3: 1 });
  });

  it('rejects a db opened with a different keyring', async () => {
    await expect(
      runKeysRotate({
        db: open(createKeyring(v3)),
        keyring: createKeyring(v3),
        logger: silent,
        out: () => undefined,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('exits with 1 and keeps PREVIOUS when a key cannot be re-wrapped', async () => {
    await seedWorkspace(v3);
    await seedWorkspace(v3);
    // The startup coverage check samples the lowest workspace id per version; corrupt the other one.
    const { rows } = await owner.query<{ lo: string; hi: string }>(
      'select min(workspace_id::text) as lo, max(workspace_id::text) as hi from workspace_keys',
    );
    const { lo, hi } = rows[0] ?? { lo: '', hi: '' };
    await owner.query(
      'update workspace_keys set wrapped_dek = (select wrapped_dek from workspace_keys where workspace_id = $1) where workspace_id = $2',
      [lo, hi],
    );
    const r = await run(createKeyring(v4, v3));
    expect(r.code).toBe(1);
    expect(r.out).toContain('Re-wrapped 1 workspace key(s) with KEK v4');
    expect(r.out).toContain(
      `FAILED ${hi}: DecryptError: KEK v3 does not open the wrapped workspace key`,
    );
    expect(r.out).toContain('Remaining stale keys: v3: 1');
    expect(r.out).not.toContain('can be removed');
    expect(await versions()).toEqual({ 3: 1, 4: 1 });
  });
});
