import { randomUUID } from 'node:crypto';
import { createSecretBox } from '@owlwire/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { openConnectionConfig } from '../repos/connection-crypto.js';
import { readConnectionConfig } from '../repos/connections.js';
import { SYSTEM, tenantScope, withTenant } from '../scope.js';
import { type LegacyDecrypt, upgradeLegacyConnectionSecrets } from './legacy-secrets.js';
import { backfillWorkspaceKeys } from './workspace-keys.js';

let env: DbTestEnv;
let decryptLegacy: LegacyDecrypt;

/** P0 biçimi: SecretBox (0x02) — V6, Sözleşme §6.2 kek_v0. */
async function insertLegacyConnection(
  workspaceId: string,
  config: Record<string, unknown> | null,
): Promise<string> {
  const id = randomUUID();
  const enc = config === null ? null : createSecretBox(env.keyring).seal(config);
  await env.owner.query(
    "insert into connections (id, workspace_id, platform, kind, display_name, config_enc, config_enc_scheme) values ($1, $2, 'telegram', 'own_bot', 'legacy', $3, 'kek_v0')",
    [id, workspaceId, enc],
  );
  return id;
}

beforeAll(async () => {
  env = await setupDbTestEnv();
  decryptLegacy = (ct) =>
    createSecretBox(env.keyring).open<Record<string, unknown>>(Buffer.from(ct));
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

describe('upgradeLegacyConnectionSecrets', () => {
  it('re-encrypts P0 rows with the workspace DEK, idempotently', async () => {
    const ws = randomUUID();
    await env.owner.query(
      "insert into workspaces (id, name, slug, kind) values ($1, 'p0', $2, 'community')",
      [ws, `p0-${ws}`],
    );
    const withConfig = await insertLegacyConnection(ws, { botToken: 'p0-token' });
    const withoutConfig = await insertLegacyConnection(ws, null);
    expect(await backfillWorkspaceKeys(SYSTEM, env.db)).toBe(1);

    const first = await upgradeLegacyConnectionSecrets(SYSTEM, env.db, decryptLegacy);
    expect(first).toEqual({ upgraded: 2, failed: [] });
    expect(
      await withTenant(env.db, tenantScope(ws), (t) =>
        readConnectionConfig(t, withConfig, { purpose: 'send' }),
      ),
    ).toEqual({
      botToken: 'p0-token',
    });
    expect(
      await withTenant(env.db, tenantScope(ws), (t) =>
        readConnectionConfig(t, withoutConfig, { purpose: 'send' }),
      ),
    ).toBeNull();

    expect(await upgradeLegacyConnectionSecrets(SYSTEM, env.db, decryptLegacy)).toEqual({
      upgraded: 0,
      failed: [],
    });
  });

  it('reports undecryptable rows and still upgrades the others', async () => {
    const ws = randomUUID();
    await env.owner.query(
      "insert into workspaces (id, name, slug, kind) values ($1, 'p0b', $2, 'community')",
      [ws, `p0b-${ws}`],
    );
    await backfillWorkspaceKeys(SYSTEM, env.db);
    const good = await insertLegacyConnection(ws, { botToken: 'ok' });
    const bad = randomUUID();
    await env.owner.query(
      "insert into connections (id, workspace_id, platform, kind, display_name, config_enc, config_enc_scheme) values ($1, $2, 'telegram', 'own_bot', 'bad', '\\x01020304'::bytea, 'kek_v0')",
      [bad, ws],
    );
    const result = await upgradeLegacyConnectionSecrets(SYSTEM, env.db, decryptLegacy);
    expect(result.upgraded).toBe(1);
    expect(result.failed.map((f) => f.connectionId)).toEqual([bad]);
    expect(result.failed[0]?.error).not.toContain('ok');
    expect(
      await withTenant(env.db, tenantScope(ws), (t) =>
        readConnectionConfig(t, good, { purpose: 'send' }),
      ),
    ).toEqual({ botToken: 'ok' });
    const { rows } = await env.owner.query(
      'select config_enc_scheme from connections where id = $1',
      [bad],
    );
    expect(rows[0]?.config_enc_scheme).toBe('kek_v0');
  });

  it('writes one instance-level audit entry per run that upgraded something', async () => {
    const { rows: entries } = await env.owner.query<{ data: { upgraded: number; failed: number } }>(
      "select data from audit_log where action = 'keys.legacy_secrets_upgraded' and workspace_id is null order by created_at, id",
    );
    expect(entries.map((e) => e.data)).toEqual([
      { upgraded: 2, failed: 0 },
      { upgraded: 1, failed: 1 },
    ]);
  });
});

describe('upgradeLegacyConnectionSecrets (soft delete and concurrency)', () => {
  beforeAll(async () => {
    // The undecryptable row above stays kek_v0 and would be reported by every later run.
    await env.owner.query("delete from connections where config_enc_scheme = 'kek_v0'");
  });

  async function newWorkspace(prefix: string): Promise<string> {
    const ws = randomUUID();
    await env.owner.query(
      "insert into workspaces (id, name, slug, kind) values ($1, $2, $3, 'community')",
      [ws, prefix, `${prefix}-${ws}`],
    );
    await backfillWorkspaceKeys(SYSTEM, env.db);
    return ws;
  }

  it('upgrades soft-deleted connections too, so their secrets stay decryptable', async () => {
    const ws = await newWorkspace('p0c');
    const id = await insertLegacyConnection(ws, { botToken: 'deleted-token' });
    await env.owner.query('update connections set deleted_at = now() where id = $1', [id]);

    expect(await upgradeLegacyConnectionSecrets(SYSTEM, env.db, decryptLegacy)).toEqual({
      upgraded: 1,
      failed: [],
    });
    const { rows } = await env.owner.query<{ config_enc: Buffer; config_enc_scheme: string }>(
      'select config_enc, config_enc_scheme from connections where id = $1',
      [id],
    );
    expect(rows[0]?.config_enc_scheme).toBe('dek_v1');
    const sealed = rows[0]?.config_enc;
    if (!sealed) throw new Error('expected sealed config');
    expect(
      await withTenant(env.db, tenantScope(ws), (t) => openConnectionConfig(t, id, sealed)),
    ).toEqual({
      botToken: 'deleted-token',
    });
  });

  it('converts each row exactly once when two upgrades run concurrently', async () => {
    const ws = await newWorkspace('p0d');
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) => insertLegacyConnection(ws, { botToken: `c${i}` })),
    );

    const [a, b] = await Promise.all([
      upgradeLegacyConnectionSecrets(SYSTEM, env.db, decryptLegacy),
      upgradeLegacyConnectionSecrets(SYSTEM, env.db, decryptLegacy),
    ]);
    expect(a.failed).toEqual([]);
    expect(b.failed).toEqual([]);
    expect(a.upgraded + b.upgraded).toBe(ids.length);
    for (const [i, id] of ids.entries()) {
      expect(
        await withTenant(env.db, tenantScope(ws), (t) =>
          readConnectionConfig(t, id, { purpose: 'send' }),
        ),
      ).toEqual({
        botToken: `c${i}`,
      });
    }
  });

  it('records a workspace without a data key as failed without leaking secret material', async () => {
    const ws = randomUUID();
    await env.owner.query(
      "insert into workspaces (id, name, slug, kind) values ($1, 'p0e', $2, 'community')",
      [ws, `p0e-${ws}`],
    );
    const id = await insertLegacyConnection(ws, { botToken: 'nokey-token' });

    const result = await upgradeLegacyConnectionSecrets(SYSTEM, env.db, decryptLegacy);
    expect(result.upgraded).toBe(0);
    expect(result.failed).toEqual([
      { connectionId: id, error: expect.stringContaining('WorkspaceKeyMissingError') },
    ]);
    expect(result.failed[0]?.error).not.toContain('nokey-token');
    expect(result.failed[0]?.error).not.toContain('params:');
  });
});
