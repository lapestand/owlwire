import { randomUUID } from 'node:crypto';
import { startTestDatabase, type TestDatabase } from '@owlwire/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RawTenant, seedRawTenant } from '../__test__/raw-seed.js';
import { migrateAll } from '../migrate-all.js';

let tdb: TestDatabase;
let owner: pg.Pool;
let a: RawTenant;
let b: RawTenant;

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl });
  a = await seedRawTenant(owner, 'alpha');
  b = await seedRawTenant(owner, 'bravo');
}, 120_000);

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const FK_VIOLATION = { code: '23503' };

describe('multi-tenant tables', () => {
  it('creates all multi-tenant tables', async () => {
    const { rows } = await owner.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename = any($1::text[]) order by 1",
      [
        [
          'audiences',
          'audience_members',
          'audit_log',
          'catalog_types',
          'connection_counters',
          'digests',
          'rate_buckets',
          'workspace_keys',
        ],
      ],
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      'audience_members',
      'audiences',
      'audit_log',
      'catalog_types',
      'connection_counters',
      'digests',
      'rate_buckets',
      'workspace_keys',
    ]);
  });

  it('defaults connections.config_enc_scheme to dek_v1 (migration 0006) and rejects unknown schemes', async () => {
    const { rows } = await owner.query('select config_enc_scheme from connections where id = $1', [
      a.connectionId,
    ]);
    expect(rows[0]?.config_enc_scheme).toBe('dek_v1');
    await expect(
      owner.query("update connections set config_enc_scheme = 'plain' where id = $1", [
        a.connectionId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('cross-workspace references are rejected by composite foreign keys', () => {
  it('destination -> other workspace connection', async () => {
    await expect(
      owner.query(
        "insert into destinations (id, workspace_id, connection_id, kind, external_id, name) values ($1, $2, $3, 'group', 'x', 'x')",
        [randomUUID(), b.workspaceId, a.connectionId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('rule_target -> other workspace destination', async () => {
    await expect(
      owner.query(
        'insert into rule_targets (id, workspace_id, rule_id, destination_id) values ($1, $2, $3, $4)',
        [randomUUID(), b.workspaceId, b.ruleId, a.destinationId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('rule_target -> other workspace audience', async () => {
    await expect(
      owner.query(
        'insert into rule_targets (id, workspace_id, rule_id, audience_id) values ($1, $2, $3, $4)',
        [randomUUID(), b.workspaceId, b.ruleId, a.audienceId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('audience_member -> other workspace destination', async () => {
    await expect(
      owner.query(
        'insert into audience_members (audience_id, destination_id, workspace_id) values ($1, $2, $3)',
        [b.audienceId, a.destinationId, b.workspaceId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('rule -> other workspace installation', async () => {
    await expect(
      owner.query(
        "insert into rules (id, workspace_id, installation_id, name, types) values ($1, $2, $3, 'x', array['*'])",
        [randomUUID(), b.workspaceId, a.installationId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('event -> other workspace installation', async () => {
    await expect(
      owner.query(
        "insert into events (id, workspace_id, installation_id, idempotency_key, type, severity, message) values ($1, $2, $3, 'k9', 'generic', 'info', '{}')",
        [randomUUID(), b.workspaceId, a.installationId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('delivery -> other workspace event / destination / connection / digest', async () => {
    const base = [randomUUID(), b.workspaceId];
    await expect(
      owner.query(
        'insert into deliveries (id, workspace_id, event_id, destination_id, connection_id) values ($1, $2, $3, $4, $5)',
        [...base, a.eventId, b.destinationId, b.connectionId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    await expect(
      owner.query(
        'insert into deliveries (id, workspace_id, event_id, destination_id, connection_id) values ($1, $2, $3, $4, $5)',
        [randomUUID(), b.workspaceId, b.eventId, a.destinationId, b.connectionId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    // Seed b'nin (event, destination) çiftinde zaten bir teslimat var; deliveries_event_destination_uq
    // FK kontrolünden önce 23505 vermesin diye digest durumu için yeni bir b olayı kullanılır.
    const freshEventId = randomUUID();
    await owner.query(
      "insert into events (id, workspace_id, installation_id, idempotency_key, type, severity, message) values ($1, $2, $3, 'k-digest', 'generic', 'info', '{}')",
      [freshEventId, b.workspaceId, b.installationId],
    );
    await expect(
      owner.query(
        'insert into deliveries (id, workspace_id, event_id, destination_id, connection_id, digest_id) values ($1, $2, $3, $4, $5, $6)',
        [randomUUID(), b.workspaceId, freshEventId, b.destinationId, b.connectionId, a.digestId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('digest and connection_counter -> other workspace connection', async () => {
    await expect(
      owner.query(
        "insert into digests (id, workspace_id, destination_id, connection_id, window_start, window_end) values ($1, $2, $3, $4, now(), now() + interval '1 minute')",
        [randomUUID(), b.workspaceId, b.destinationId, a.connectionId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    await expect(
      owner.query(
        'insert into connection_counters (connection_id, workspace_id, day) values ($1, $2, current_date - 1)',
        [a.connectionId, b.workspaceId],
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('deleting a destination cascades its audience memberships', async () => {
    const c = await seedRawTenant(owner, 'charlie');
    await owner.query('delete from rule_targets where id = $1', [c.ruleTargetId]);
    await owner.query('delete from deliveries where id = $1', [c.deliveryId]);
    await owner.query('delete from digests where id = $1', [c.digestId]);
    await owner.query('delete from destinations where id = $1', [c.destinationId]);
    const { rows } = await owner.query(
      'select count(*)::int as n from audience_members where audience_id = $1',
      [c.audienceId],
    );
    expect(rows[0]?.n).toBe(0);
  });
});
