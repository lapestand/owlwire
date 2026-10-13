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
  for (const k of [v1, v2, v3]) expect(out).not.toContain(b64(k));
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

  it('exits with 1 and keeps PREVIOUS when a key cannot be re-wrapped', async () => {
    await seedDevWorkspace(open(createKeyring(v2)), { platform: 'webhook' });
    // The startup coverage check samples the lowest workspace id per version; corrupt the other one.
    const { rows } = await owner.query<{ lo: string; hi: string }>(
      'select min(workspace_id::text) as lo, max(workspace_id::text) as hi from workspace_keys',
    );
    const { lo, hi } = rows[0] ?? { lo: '', hi: '' };
    await owner.query(
      'update workspace_keys set wrapped_dek = (select wrapped_dek from workspace_keys where workspace_id = $1) where workspace_id = $2',
      [lo, hi],
    );
    const r = await run(createKeyring(v3, v2));
    expect(r.code).toBe(1);
    expect(r.out).toContain('Re-wrapped 1 workspace key(s) with KEK v3');
    expect(r.out).toContain(
      `FAILED ${hi}: DecryptError: KEK v2 does not open the wrapped workspace key`,
    );
    expect(r.out).toContain('Remaining stale keys: v2: 1');
    expect(r.out).not.toContain('can be removed');
    expect(await versions()).toEqual({ 2: 1, 3: 1 });
  });
});
