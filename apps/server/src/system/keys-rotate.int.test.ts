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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl });
}, 120_000);

afterAll(async () => {
  for (const db of opened) await db.close();
  await owner?.end();
  await tdb?.stop();
});

describe('owlwire keys rotate', () => {
  let workspaceId = '';
  let legacyConnectionId = '';

  it('reports nothing to do when keys are current', async () => {
    workspaceId = (await seedDevWorkspace(open(createKeyring(v1)), { platform: 'telegram' }))
      .workspaceId;
    const r = await run(createKeyring(v1));
    expect(r.code).toBe(0);
    expect(r.out).toContain('already');
    expect(r.out).not.toContain('can be removed');
  });

  it('exits with 2 when stale keys exist but OWLWIRE_KEK_PREVIOUS is missing', async () => {
    const r = await run(createKeyring(v2));
    expect(r.code).toBe(2);
    expect(r.out).toContain('OWLWIRE_KEK_PREVIOUS');
    expect(r.out).toContain('v1: 1');
    expect(await versions()).toEqual({ 1: 1 });
  });

  it('exits with 2 when OWLWIRE_KEK_PREVIOUS holds the wrong key for its version', async () => {
    const r = await run(createKeyring(v2, generateKek(1)));
    expect(r.code).toBe(2);
    expect(r.out).toContain('does not open the stored workspace keys');
    expect(await versions()).toEqual({ 1: 1 });
  });

  it('upgrades P0 SecretBox secrets sealed with the old KEK, rotates, and says PREVIOUS can be removed', async () => {
    legacyConnectionId = randomUUID();
    await owner.query(
      "insert into connections (id, workspace_id, platform, kind, display_name, config_enc, config_enc_scheme) values ($1, $2, 'telegram', 'own_bot', 'legacy', $3, 'kek_v0')",
      [
        legacyConnectionId,
        workspaceId,
        createSecretBox(createKeyring(v1)).seal({ botToken: 'legacy-token' }),
      ],
    );
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

  it('says PREVIOUS can be removed on a re-run that finds nothing to rotate', async () => {
    const r = await run(createKeyring(v2, v1));
    expect(r.code).toBe(0);
    expect(r.out).toContain('already');
    expect(r.out).toContain('OWLWIRE_KEK_PREVIOUS can be removed');
  });

  it('refuses to re-wrap newer keys down when OWLWIRE_KEK and OWLWIRE_KEK_PREVIOUS are swapped', async () => {
    const { rows: before } = await owner.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'keys.kek_rotated'",
    );
    const r = await run(createKeyring(v1, v2));
    expect(r.code).toBe(2);
    expect(r.out).toContain('v2 are newer than OWLWIRE_KEK_VERSION v1');
    expect(r.out).toContain('look swapped');
    expect(r.out).not.toContain('can be removed');
    expect(await versions()).toEqual({ 2: 1 });
    const { rows: after } = await owner.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'keys.kek_rotated'",
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('exits with 2 when a legacy secret is sealed with an unconfigured KEK version', async () => {
    const id = randomUUID();
    await owner.query(
      "insert into connections (id, workspace_id, platform, kind, display_name, config_enc, config_enc_scheme) values ($1, $2, 'telegram', 'own_bot', 'legacy9', $3, 'kek_v0')",
      [id, workspaceId, createSecretBox(createKeyring(generateKek(9))).seal({ botToken: 'x' })],
    );
    try {
      const r = await run(createKeyring(v2));
      expect(r.code).toBe(2);
      expect(r.out).toContain('Legacy secrets are sealed with KEK v9');
      expect(r.out).toContain('OWLWIRE_KEK_PREVIOUS');
      expect(r.out).not.toContain('can be removed');
    } finally {
      await owner.query('delete from connections where id = $1', [id]);
    }
  });

  it('exits with 1 when a P0 secret appears during the run', async () => {
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
    await seedDevWorkspace(open(createKeyring(v3)), { platform: 'webhook' });
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
