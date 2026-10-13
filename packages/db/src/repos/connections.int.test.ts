import { randomUUID } from 'node:crypto';
import { DecryptError } from '@owlwire/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import { LegacySecretError, RepoConflictError, RepoNotFoundError } from '../errors.js';
import { type TenantTx, tenantScope, withTenant } from '../scope.js';
import { listAuditLog, SYSTEM_ACTOR } from './audit.js';
import { sealConnectionConfig } from './connection-crypto.js';
import {
  type ConnectionRow,
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  readConnectionConfig,
  updateConnectionConfig,
  updateConnectionStatus,
} from './connections.js';
import {
  createDestination,
  getDestination,
  getDestinationsByIds,
  listDestinations,
  updateDestinationStatus,
} from './destinations.js';

let env: DbTestEnv;
let A: string;
let B: string;
const SECRET = '123456:SECRET-TOKEN-VALUE';

const inA = <T>(fn: (t: TenantTx) => Promise<T>) => withTenant(env.db, tenantScope(A), fn);
const inB = <T>(fn: (t: TenantTx) => Promise<T>) => withTenant(env.db, tenantScope(B), fn);

const newBot = (displayName: string, botToken: string) =>
  ({ platform: 'telegram', kind: 'own_bot', displayName, config: { botToken } }) as const;

beforeAll(async () => {
  env = await setupDbTestEnv();
  A = await createTestWorkspace(env.db, 'alpha');
  B = await createTestWorkspace(env.db, 'bravo');
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

describe('connection config encryption', () => {
  it('stores config sealed with the workspace DEK and reads it for sending without auditing', async () => {
    const conn = await inA((t) => createConnection(t, newBot('bot', SECRET), SYSTEM_ACTOR));
    expect(conn).not.toHaveProperty('configEnc');
    const { rows } = await env.owner.query(
      'select config_enc, config_enc_scheme from connections where id = $1',
      [conn.id],
    );
    expect(rows[0]?.config_enc_scheme).toBe('dek_v1');
    expect(Buffer.from(rows[0]?.config_enc).includes(Buffer.from('SECRET-TOKEN'))).toBe(false);
    expect(await inA((t) => readConnectionConfig(t, conn.id, { purpose: 'send' }))).toEqual({
      botToken: SECRET,
    });
    const audit = await inA((t) => listAuditLog(t));
    expect(audit.map((a) => a.action)).not.toContain('connection.secret_viewed');
    expect(audit.map((a) => a.action)).toContain('connection.created');
  });

  it('records connection.secret_viewed when revealing', async () => {
    const conn = await inA((t) => createConnection(t, newBot('reveal', SECRET), SYSTEM_ACTOR));
    await inA((t) => readConnectionConfig(t, conn.id, { purpose: 'reveal', actor: SYSTEM_ACTOR }));
    const audit = await inA((t) => listAuditLog(t, { limit: 1 }));
    expect(audit[0]).toMatchObject({ action: 'connection.secret_viewed', targetId: conn.id });
  });

  it('never writes config values into the audit log', async () => {
    const conn = await inA((t) => createConnection(t, newBot('audit', SECRET), SYSTEM_ACTOR));
    await inA((t) => updateConnectionConfig(t, conn.id, { botToken: `${SECRET}-2` }, SYSTEM_ACTOR));
    const { rows } = await env.owner.query<{ data: string }>(
      'select data::text as data from audit_log where workspace_id = $1',
      [A],
    );
    for (const r of rows) expect(r.data).not.toContain('SECRET-TOKEN');
    const updated = rows.map((r) => r.data).find((d) => d.includes('fieldNames'));
    expect(updated).toContain('botToken');
  });

  it('refuses a ciphertext copied from another connection of the same workspace', async () => {
    const c1 = await inA((t) => createConnection(t, newBot('c1', 'one'), SYSTEM_ACTOR));
    const c2 = await inA((t) => createConnection(t, newBot('c2', 'two'), SYSTEM_ACTOR));
    await env.owner.query(
      'update connections set config_enc = (select config_enc from connections where id = $1) where id = $2',
      [c1.id, c2.id],
    );
    await expect(
      inA((t) => readConnectionConfig(t, c2.id, { purpose: 'send' })),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it('refuses a ciphertext copied from another workspace', async () => {
    const ca = await inA((t) => createConnection(t, newBot('ca', 'alpha-secret'), SYSTEM_ACTOR));
    const cb = await inB((t) => createConnection(t, newBot('cb', 'bravo-secret'), SYSTEM_ACTOR));
    await env.owner.query(
      'update connections set config_enc = (select config_enc from connections where id = $1) where id = $2',
      [ca.id, cb.id],
    );
    await expect(
      inB((t) => readConnectionConfig(t, cb.id, { purpose: 'send' })),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it('returns null for connections without config', async () => {
    const conn = await inA((t) =>
      createConnection(
        t,
        { platform: 'telegram', kind: 'shared_bot', displayName: 'shared', config: null },
        SYSTEM_ACTOR,
      ),
    );
    expect(await inA((t) => readConnectionConfig(t, conn.id, { purpose: 'send' }))).toBeNull();
  });

  it('raises LegacySecretError for rows still on the P0 scheme', async () => {
    const conn = await inA((t) => createConnection(t, newBot('legacy', SECRET), SYSTEM_ACTOR));
    await env.owner.query("update connections set config_enc_scheme = 'kek_v0' where id = $1", [
      conn.id,
    ]);
    await expect(
      inA((t) => readConnectionConfig(t, conn.id, { purpose: 'send' })),
    ).rejects.toBeInstanceOf(LegacySecretError);
  });
});

describe('connection isolation', () => {
  it('another workspace cannot read, change or delete the connection', async () => {
    const conn = await inA((t) => createConnection(t, newBot('iso', SECRET), SYSTEM_ACTOR));
    expect(await inB((t) => getConnection(t, conn.id))).toBeNull();
    expect((await inB((t) => listConnections(t))).map((c) => c.id)).not.toContain(conn.id);
    await expect(
      inB((t) => readConnectionConfig(t, conn.id, { purpose: 'send' })),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(
      inB((t) => updateConnectionConfig(t, conn.id, { botToken: 'evil' }, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(
      inB((t) => updateConnectionStatus(t, conn.id, 'paused', 'evil')),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(inB((t) => deleteConnection(t, conn.id, SYSTEM_ACTOR))).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
    expect(await inA((t) => readConnectionConfig(t, conn.id, { purpose: 'send' }))).toEqual({
      botToken: SECRET,
    });
    expect((await inA((t) => getConnection(t, conn.id)))?.status).toBe('pending');
  });

  it('soft-deletes an own connection with its destinations and audits it (R101)', async () => {
    const conn = await inA((t) => createConnection(t, newBot('del', SECRET), SYSTEM_ACTOR));
    const dest = await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-100del',
        name: 'Del group',
        consentStatus: 'confirmed',
      }),
    );
    await inA((t) => deleteConnection(t, conn.id, SYSTEM_ACTOR));
    expect(await inA((t) => getConnection(t, conn.id))).toBeNull();
    expect((await inA((t) => listConnections(t))).map((c) => c.id)).not.toContain(conn.id);
    expect(await inA((t) => getDestination(t, dest.id))).toBeNull();
    expect(await inA((t) => listDestinations(t, { connectionId: conn.id }))).toEqual([]);
    await expect(inA((t) => deleteConnection(t, conn.id, SYSTEM_ACTOR))).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
    const { rows } = await env.owner.query(
      `select (select deleted_at from connections where id = $1) is not null as conn_deleted,
              (select deleted_at from destinations where id = $2) is not null as dest_deleted`,
      [conn.id, dest.id],
    );
    expect(rows[0]).toEqual({ conn_deleted: true, dest_deleted: true });
    const audit = await inA((t) => listAuditLog(t, { limit: 1 }));
    expect(audit[0]).toMatchObject({ action: 'connection.deleted', targetId: conn.id });
  });

  it('fails parked pending/scheduled deliveries of the connection on delete, keeps delivered ones (R125)', async () => {
    const conn = await inA((t) => createConnection(t, newBot('park', SECRET), SYSTEM_ACTOR));
    const mkDest = (ext: string) =>
      inA((t) =>
        createDestination(t, {
          connectionId: conn.id,
          kind: 'group',
          externalId: ext,
          name: ext,
          consentStatus: 'confirmed',
        }),
      );
    const dPending = await mkDest('-100park1');
    const dScheduled = await mkDest('-100park2');
    const dDelivered = await mkDest('-100park3');
    // Ham tohum (sahip rolü, RLS'siz): uygulama, kurulum, olay ve üç teslimat — seedRawTenant ile aynı kolonlar.
    const appId = randomUUID();
    const installationId = randomUUID();
    const eventId = randomUUID();
    await env.owner.query(
      "insert into apps (id, owner_workspace_id, name, slug, visibility) values ($1, $2, 'park app', $3, 'private')",
      [appId, A, `app-${appId}`],
    );
    await env.owner.query(
      "insert into installations (id, app_id, workspace_id, token_hash, token_prefix) values ($1, $2, $3, $4, 'ow_inst_test')",
      [installationId, appId, A, `hash-${installationId}`],
    );
    await env.owner.query(
      "insert into events (id, workspace_id, installation_id, idempotency_key, type, severity, message) values ($1, $2, $3, 'park-k1', 'generic', 'info', '{}'::jsonb)",
      [eventId, A, installationId],
    );
    const pendingId = randomUUID();
    const scheduledId = randomUUID();
    const deliveredId = randomUUID();
    const insertDelivery = (id: string, destinationId: string, status: string) =>
      env.owner.query(
        `insert into deliveries (id, workspace_id, event_id, destination_id, connection_id, status, next_attempt_at, delivered_at)
         values ($1, $2, $3, $4, $5, $6, null, case when $6::text = 'delivered' then now() end)`,
        [id, A, eventId, destinationId, conn.id, status],
      );
    await insertDelivery(pendingId, dPending.id, 'pending');
    await insertDelivery(scheduledId, dScheduled.id, 'scheduled'); // park edilmiş: next_attempt_at NULL, kuyrukta iş yok
    await insertDelivery(deliveredId, dDelivered.id, 'delivered');

    await inA((t) => deleteConnection(t, conn.id, SYSTEM_ACTOR));

    const { rows } = await env.owner.query<{
      id: string;
      status: string;
      last_error: string | null;
      next_attempt_at: Date | null;
    }>(
      'select id, status, last_error, next_attempt_at from deliveries where id = any($1::uuid[])',
      [[pendingId, scheduledId, deliveredId]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [pendingId, scheduledId]) {
      expect(byId.get(id)).toMatchObject({
        status: 'failed',
        last_error: 'connection_deleted',
        next_attempt_at: null,
      });
    }
    expect(byId.get(deliveredId)).toMatchObject({ status: 'delivered', last_error: null });
  });
});

describe('destinations', () => {
  it('creates, gets and lists destinations of an own connection', async () => {
    const conn = await inA((t) => createConnection(t, newBot('d', SECRET), SYSTEM_ACTOR));
    const dest = await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-1001',
        name: 'Alliance',
        consentStatus: 'confirmed',
      }),
    );
    expect(await inA((t) => getDestination(t, dest.id))).toMatchObject({
      id: dest.id,
      workspaceId: A,
      consentStatus: 'confirmed',
    });
    expect(
      (await inA((t) => listDestinations(t, { connectionId: conn.id }))).map((d) => d.id),
    ).toEqual([dest.id]);
  });

  it('rejects a destination on another workspace connection', async () => {
    const conn = await inA((t) => createConnection(t, newBot('foreign', SECRET), SYSTEM_ACTOR));
    await expect(
      inB((t) =>
        createDestination(t, {
          connectionId: conn.id,
          kind: 'group',
          externalId: '-1002',
          name: 'x',
        }),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('rejects a duplicate external id on the same connection', async () => {
    const conn = await inA((t) => createConnection(t, newBot('dup', SECRET), SYSTEM_ACTOR));
    await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-1003',
        name: 'x',
      }),
    );
    await expect(
      inA((t) =>
        createDestination(t, {
          connectionId: conn.id,
          kind: 'group',
          externalId: '-1003',
          name: 'y',
        }),
      ),
    ).rejects.toBeInstanceOf(RepoConflictError);
  });

  it('getDestinationsByIds ignores ids of other workspaces and handles empty input', async () => {
    const conn = await inA((t) => createConnection(t, newBot('ids', SECRET), SYSTEM_ACTOR));
    const dest = await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-1004',
        name: 'x',
      }),
    );
    expect(await inB((t) => getDestinationsByIds(t, [dest.id]))).toEqual([]);
    expect(await inA((t) => getDestinationsByIds(t, []))).toEqual([]);
    expect((await inA((t) => getDestinationsByIds(t, [dest.id]))).map((d) => d.id)).toEqual([
      dest.id,
    ]);
  });
});

// ConnectionRow never carries the ciphertext: this fails to typecheck if configEnc/configEncScheme come back.
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
const connectionRowHasConfigEnc: HasKey<ConnectionRow, 'configEnc'> = false;
const connectionRowHasConfigEncScheme: HasKey<ConnectionRow, 'configEncScheme'> = false;

/** Owner-role seed of an app, installation, rule and audience in a workspace (RLS bypassed, fixtures only). */
async function seedRuleAndAudience(workspaceId: string) {
  const appId = randomUUID();
  const installationId = randomUUID();
  const ruleId = randomUUID();
  const audienceId = randomUUID();
  await env.owner.query(
    "insert into apps (id, owner_workspace_id, name, slug, visibility) values ($1, $2, 'seed app', $3, 'private')",
    [appId, workspaceId, `app-${appId}`],
  );
  await env.owner.query(
    "insert into installations (id, app_id, workspace_id, token_hash, token_prefix) values ($1, $2, $3, $4, 'ow_inst_test')",
    [installationId, appId, workspaceId, `hash-${installationId}`],
  );
  await env.owner.query(
    "insert into rules (id, workspace_id, installation_id, name, types) values ($1, $2, $3, 'r', array['*'])",
    [ruleId, workspaceId, installationId],
  );
  await env.owner.query('insert into audiences (id, workspace_id, name) values ($1, $2, $3)', [
    audienceId,
    workspaceId,
    `aud-${audienceId}`,
  ]);
  return { installationId, ruleId, audienceId };
}

describe('connection rows', () => {
  it('never expose the sealed config at runtime', async () => {
    expect(connectionRowHasConfigEnc).toBe(false);
    expect(connectionRowHasConfigEncScheme).toBe(false);
    const conn = await inA((t) => createConnection(t, newBot('shape', SECRET), SYSTEM_ACTOR));
    const got = await inA((t) => getConnection(t, conn.id));
    const listed = (await inA((t) => listConnections(t))).find((c) => c.id === conn.id);
    for (const row of [conn, got, listed]) {
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('configEnc');
      expect(row).not.toHaveProperty('configEncScheme');
      expect(JSON.stringify(row)).not.toContain('SECRET-TOKEN');
    }
  });

  it('updates the status of an own connection', async () => {
    const conn = await inA((t) => createConnection(t, newBot('status', SECRET), SYSTEM_ACTOR));
    await inA((t) => updateConnectionStatus(t, conn.id, 'broken', 'token revoked'));
    expect(await inA((t) => getConnection(t, conn.id))).toMatchObject({
      status: 'broken',
      statusReason: 'token revoked',
    });
  });

  it('replaces and clears the sealed config', async () => {
    const conn = await inA((t) => createConnection(t, newBot('replace', SECRET), SYSTEM_ACTOR));
    await inA((t) => updateConnectionConfig(t, conn.id, { botToken: 'next' }, SYSTEM_ACTOR));
    expect(await inA((t) => readConnectionConfig(t, conn.id, { purpose: 'send' }))).toEqual({
      botToken: 'next',
    });
    await inA((t) => updateConnectionConfig(t, conn.id, null, SYSTEM_ACTOR));
    expect(await inA((t) => readConnectionConfig(t, conn.id, { purpose: 'send' }))).toBeNull();
  });

  it('upgrades a legacy row to dek_v1 when its config is replaced', async () => {
    const conn = await inA((t) => createConnection(t, newBot('relegacy', SECRET), SYSTEM_ACTOR));
    await env.owner.query("update connections set config_enc_scheme = 'kek_v0' where id = $1", [
      conn.id,
    ]);
    await inA((t) => updateConnectionConfig(t, conn.id, { botToken: 'fresh' }, SYSTEM_ACTOR));
    expect(await inA((t) => readConnectionConfig(t, conn.id, { purpose: 'send' }))).toEqual({
      botToken: 'fresh',
    });
  });
});

describe('soft-deleted connections and destinations stay hidden (R101)', () => {
  it('rejects every read and change of a deleted connection', async () => {
    const conn = await inA((t) => createConnection(t, newBot('gone', SECRET), SYSTEM_ACTOR));
    const dest = await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-100gone',
        name: 'gone',
      }),
    );
    await inA((t) => deleteConnection(t, conn.id, SYSTEM_ACTOR));
    await expect(
      inA((t) => readConnectionConfig(t, conn.id, { purpose: 'send' })),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(
      inA((t) => readConnectionConfig(t, conn.id, { purpose: 'reveal', actor: SYSTEM_ACTOR })),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(
      inA((t) => updateConnectionConfig(t, conn.id, { botToken: 'x' }, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(
      inA((t) => updateConnectionStatus(t, conn.id, 'active', null)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    expect(await inA((t) => getDestinationsByIds(t, [dest.id]))).toEqual([]);
    expect((await inA((t) => listDestinations(t))).map((d) => d.id)).not.toContain(dest.id);
    await expect(
      inA((t) => updateDestinationStatus(t, dest.id, 'broken', 'x')),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(
      inA((t) =>
        createDestination(t, {
          connectionId: conn.id,
          kind: 'group',
          externalId: '-100gone2',
          name: 'late',
        }),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('hides a live destination row whose connection is deleted', async () => {
    const conn = await inA((t) => createConnection(t, newBot('orphan', SECRET), SYSTEM_ACTOR));
    await inA((t) => deleteConnection(t, conn.id, SYSTEM_ACTOR));
    // A destination row that escaped the cascade (e.g. a racing insert) still has deleted_at null.
    const orphanId = randomUUID();
    await env.owner.query(
      "insert into destinations (id, workspace_id, connection_id, kind, external_id, name) values ($1, $2, $3, 'group', '-100orphan', 'orphan')",
      [orphanId, A, conn.id],
    );
    expect(await inA((t) => getDestination(t, orphanId))).toBeNull();
    expect(await inA((t) => getDestinationsByIds(t, [orphanId]))).toEqual([]);
    expect((await inA((t) => listDestinations(t))).map((d) => d.id)).not.toContain(orphanId);
    expect(await inA((t) => listDestinations(t, { connectionId: conn.id }))).toEqual([]);
    await expect(
      inA((t) => updateDestinationStatus(t, orphanId, 'broken', 'x')),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('removes only the rule targets and audience memberships of the deleted connection', async () => {
    const gone = await inA((t) => createConnection(t, newBot('scope-gone', SECRET), SYSTEM_ACTOR));
    const kept = await inA((t) => createConnection(t, newBot('scope-kept', SECRET), SYSTEM_ACTOR));
    const dGone = await inA((t) =>
      createDestination(t, {
        connectionId: gone.id,
        kind: 'group',
        externalId: '-100sg',
        name: 'sg',
      }),
    );
    const dKept = await inA((t) =>
      createDestination(t, {
        connectionId: kept.id,
        kind: 'group',
        externalId: '-100sk',
        name: 'sk',
      }),
    );
    const { ruleId, audienceId } = await seedRuleAndAudience(A);
    const targetGone = randomUUID();
    const targetKept = randomUUID();
    const targetAudience = randomUUID();
    const addTarget = (id: string, dest: string | null, aud: string | null) =>
      env.owner.query(
        'insert into rule_targets (id, workspace_id, rule_id, destination_id, audience_id) values ($1, $2, $3, $4, $5)',
        [id, A, ruleId, dest, aud],
      );
    await addTarget(targetGone, dGone.id, null);
    await addTarget(targetKept, dKept.id, null);
    await addTarget(targetAudience, null, audienceId);
    for (const d of [dGone.id, dKept.id]) {
      await env.owner.query(
        'insert into audience_members (audience_id, destination_id, workspace_id) values ($1, $2, $3)',
        [audienceId, d, A],
      );
    }

    await inA((t) => deleteConnection(t, gone.id, SYSTEM_ACTOR));

    const targets = await env.owner.query<{ id: string }>(
      'select id from rule_targets where rule_id = $1',
      [ruleId],
    );
    expect(targets.rows.map((r) => r.id).sort()).toEqual([targetKept, targetAudience].sort());
    const members = await env.owner.query<{ destination_id: string }>(
      'select destination_id from audience_members where audience_id = $1',
      [audienceId],
    );
    expect(members.rows.map((r) => r.destination_id)).toEqual([dKept.id]);
    expect(await inA((t) => getConnection(t, kept.id))).not.toBeNull();
    expect(await inA((t) => getDestination(t, dKept.id))).not.toBeNull();
  });
});

describe('destination edge cases', () => {
  it('getDestinationsByIds tolerates duplicates and unknown ids', async () => {
    const conn = await inA((t) => createConnection(t, newBot('dupe-ids', SECRET), SYSTEM_ACTOR));
    const d1 = await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-100i1',
        name: 'i1',
      }),
    );
    const d2 = await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-100i2',
        name: 'i2',
      }),
    );
    const got = await inA((t) => getDestinationsByIds(t, [d1.id, d2.id, d1.id, randomUUID()]));
    expect(got.map((d) => d.id).sort()).toEqual([d1.id, d2.id].sort());
  });

  it('updates the status of an own destination', async () => {
    const conn = await inA((t) => createConnection(t, newBot('dstatus', SECRET), SYSTEM_ACTOR));
    const dest = await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-100ds',
        name: 'ds',
      }),
    );
    await inA((t) => updateDestinationStatus(t, dest.id, 'broken', 'kicked'));
    expect(await inA((t) => getDestination(t, dest.id))).toMatchObject({
      status: 'broken',
      statusReason: 'kicked',
    });
  });

  it('allows the same external id on different connections and sub ids', async () => {
    const c1 = await inA((t) => createConnection(t, newBot('ext1', SECRET), SYSTEM_ACTOR));
    const c2 = await inA((t) => createConnection(t, newBot('ext2', SECRET), SYSTEM_ACTOR));
    await inA((t) =>
      createDestination(t, {
        connectionId: c1.id,
        kind: 'group',
        externalId: '-100same',
        name: 'a',
      }),
    );
    await inA((t) =>
      createDestination(t, {
        connectionId: c2.id,
        kind: 'group',
        externalId: '-100same',
        name: 'b',
      }),
    );
    await inA((t) =>
      createDestination(t, {
        connectionId: c1.id,
        kind: 'topic',
        externalId: '-100same',
        externalSubId: '7',
        name: 'c',
      }),
    );
    expect(await inA((t) => listDestinations(t, { connectionId: c1.id }))).toHaveLength(2);
  });
});

describe('destination isolation (R121)', () => {
  it('another workspace cannot read, list or change the destination', async () => {
    const conn = await inA((t) => createConnection(t, newBot('diso', SECRET), SYSTEM_ACTOR));
    const dest = await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-100diso',
        name: 'diso',
      }),
    );
    expect(await inB((t) => getDestination(t, dest.id))).toBeNull();
    expect((await inB((t) => listDestinations(t))).map((d) => d.id)).not.toContain(dest.id);
    expect(await inB((t) => listDestinations(t, { connectionId: conn.id }))).toEqual([]);
    expect(await inB((t) => getDestinationsByIds(t, [dest.id, dest.id]))).toEqual([]);
    await expect(
      inB((t) => updateDestinationStatus(t, dest.id, 'broken', 'evil')),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    expect(await inA((t) => getDestination(t, dest.id))).toMatchObject({
      status: 'active',
      statusReason: null,
    });
  });

  it('deleting a connection in one workspace leaves the other workspace untouched', async () => {
    const ca = await inA((t) => createConnection(t, newBot('wa', SECRET), SYSTEM_ACTOR));
    const da = await inA((t) =>
      createDestination(t, {
        connectionId: ca.id,
        kind: 'group',
        externalId: '-100wa',
        name: 'wa',
      }),
    );
    const cb = await inB((t) => createConnection(t, newBot('wb', SECRET), SYSTEM_ACTOR));
    await inB((t) => deleteConnection(t, cb.id, SYSTEM_ACTOR));
    expect(await inA((t) => getConnection(t, ca.id))).not.toBeNull();
    expect(await inA((t) => getDestination(t, da.id))).not.toBeNull();
    expect(await inA((t) => readConnectionConfig(t, ca.id, { purpose: 'send' }))).toEqual({
      botToken: SECRET,
    });
  });

  it('connection writes land in the caller workspace only', async () => {
    const cb = await inB((t) => createConnection(t, newBot('own-b', SECRET), SYSTEM_ACTOR));
    expect(cb.workspaceId).toBe(B);
    expect(await inA((t) => getConnection(t, cb.id))).toBeNull();
    const audit = await inA((t) => listAuditLog(t));
    expect(audit.map((a) => a.targetId)).not.toContain(cb.id);
  });
});

describe('fix round 1', () => {
  it('refuses a ciphertext sealed with another workspace key even when the AAD matches', async () => {
    const cb = await inB((t) =>
      createConnection(t, newBot('aad-match', 'bravo-secret'), SYSTEM_ACTOR),
    );
    // Sealed in A for B's connection id: the AAD is identical, only the workspace DEK differs.
    const foreign = await inA((t) => sealConnectionConfig(t, cb.id, { botToken: 'alpha-forged' }));
    await env.owner.query('update connections set config_enc = $1 where id = $2', [foreign, cb.id]);
    await expect(
      inB((t) => readConnectionConfig(t, cb.id, { purpose: 'send' })),
    ).rejects.toBeInstanceOf(DecryptError);
    // Control: the same path with B's own key decrypts, so the failure above comes from the key alone.
    const own = await inB((t) => sealConnectionConfig(t, cb.id, { botToken: 'bravo-again' }));
    await env.owner.query('update connections set config_enc = $1 where id = $2', [own, cb.id]);
    expect(await inB((t) => readConnectionConfig(t, cb.id, { purpose: 'send' }))).toEqual({
      botToken: 'bravo-again',
    });
  });

  it('a foreign deleteConnection leaves the whole connection graph intact', async () => {
    const conn = await inA((t) => createConnection(t, newBot('graph', SECRET), SYSTEM_ACTOR));
    const dest = await inA((t) =>
      createDestination(t, {
        connectionId: conn.id,
        kind: 'group',
        externalId: '-100graph',
        name: 'graph',
      }),
    );
    const { installationId, ruleId, audienceId } = await seedRuleAndAudience(A);
    const targetId = randomUUID();
    await env.owner.query(
      'insert into rule_targets (id, workspace_id, rule_id, destination_id) values ($1, $2, $3, $4)',
      [targetId, A, ruleId, dest.id],
    );
    await env.owner.query(
      'insert into audience_members (audience_id, destination_id, workspace_id) values ($1, $2, $3)',
      [audienceId, dest.id, A],
    );
    const eventId = randomUUID();
    await env.owner.query(
      "insert into events (id, workspace_id, installation_id, idempotency_key, type, severity, message) values ($1, $2, $3, $4, 'generic', 'info', '{}'::jsonb)",
      [eventId, A, installationId, `graph-${eventId}`],
    );
    const deliveryId = randomUUID();
    await env.owner.query(
      "insert into deliveries (id, workspace_id, event_id, destination_id, connection_id, status) values ($1, $2, $3, $4, $5, 'pending')",
      [deliveryId, A, eventId, dest.id, conn.id],
    );

    await expect(inB((t) => deleteConnection(t, conn.id, SYSTEM_ACTOR))).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );

    const { rows } = await env.owner.query(
      `select (select deleted_at from connections where id = $1) as conn_deleted_at,
              (select deleted_at from destinations where id = $2) as dest_deleted_at,
              (select count(*)::int from rule_targets where id = $3) as targets,
              (select count(*)::int from audience_members where audience_id = $4 and destination_id = $2) as members,
              (select status from deliveries where id = $5) as delivery_status,
              (select last_error from deliveries where id = $5) as delivery_error`,
      [conn.id, dest.id, targetId, audienceId, deliveryId],
    );
    expect(rows[0]).toEqual({
      conn_deleted_at: null,
      dest_deleted_at: null,
      targets: 1,
      members: 1,
      delivery_status: 'pending',
      delivery_error: null,
    });
    const audit = await inB((t) => listAuditLog(t));
    expect(audit.map((a) => a.targetId)).not.toContain(conn.id);
  });

  it('updateConnectionConfig reports a missing connection before touching the DEK', async () => {
    const C = await createTestWorkspace(env.db, 'charlie');
    await env.owner.query('delete from workspace_keys where workspace_id = $1', [C]);
    const conn = await inA((t) => createConnection(t, newBot('nokey', SECRET), SYSTEM_ACTOR));
    const inC = <T>(fn: (t: TenantTx) => Promise<T>) => withTenant(env.db, tenantScope(C), fn);
    // C has no DEK: sealing first would surface WorkspaceKeyMissingError instead.
    await expect(
      inC((t) => updateConnectionConfig(t, randomUUID(), { botToken: 'x' }, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(
      inC((t) => updateConnectionConfig(t, conn.id, { botToken: 'x' }, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});
