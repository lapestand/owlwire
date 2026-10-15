import { verifyTokenHash } from '@owlwire/crypto';
import { readConnectionConfig, tenantScope, withTenant } from '@owlwire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDeliveryWorkspace } from './fixtures.js';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('seedDeliveryWorkspace', () => {
  it('uses the shared bot (no config, no destination) without a bot token', async () => {
    const r = await seedDeliveryWorkspace(h.deps.db, { platform: 'telegram' });
    expect(r.destinationId).toBeNull();
    const conn = (
      await h.ownerPool.query('select kind, config_enc from connections where id = $1', [
        r.connectionId,
      ])
    ).rows[0];
    expect(conn).toMatchObject({ kind: 'shared_bot', config_enc: null });
  });

  it('creates a full telegram route with an encrypted bot token', async () => {
    const r = await seedDeliveryWorkspace(h.deps.db, {
      platform: 'telegram',
      botToken: '123:ABC',
      chatId: '-1001234',
    });
    // Assertions through the owner pool (outside RLS).
    const inst = (
      await h.ownerPool.query<{ token_hash: string; token_prefix: string }>(
        'select token_hash, token_prefix from installations where id = $1',
        [r.installationId],
      )
    ).rows[0];
    expect(inst && verifyTokenHash(r.token, inst.token_hash)).toBe(true);
    expect(inst?.token_prefix).toBe(r.token.slice(0, 12));

    const conn = (
      await h.ownerPool.query(
        'select platform, kind, status, config_enc_scheme from connections where id = $1',
        [r.connectionId],
      )
    ).rows[0];
    expect(conn).toMatchObject({
      platform: 'telegram',
      kind: 'own_bot',
      status: 'active',
      config_enc_scheme: 'dek_v1',
    });
    expect(
      await withTenant(h.deps.db, tenantScope(r.workspaceId), (t) =>
        readConnectionConfig(t, r.connectionId, { purpose: 'send' }),
      ),
    ).toEqual({ botToken: '123:ABC' });

    const dest = (
      await h.ownerPool.query(
        'select kind, external_id, consent_status from destinations where id = $1',
        [r.destinationId],
      )
    ).rows[0];
    expect(dest).toMatchObject({
      kind: 'group',
      external_id: '-1001234',
      consent_status: 'confirmed',
    });

    const rule = (
      await h.ownerPool.query<{ types: string[] }>('select types from rules where id = $1', [
        r.ruleId,
      ])
    ).rows[0];
    expect(rule?.types).toEqual(['*']);
    const targets = await h.ownerPool.query<{ destination_id: string }>(
      'select destination_id from rule_targets where rule_id = $1',
      [r.ruleId],
    );
    expect(targets.rows.map((t) => t.destination_id)).toEqual([r.destinationId]);
  });

  it('creates a fake webhook route without config and can run twice', async () => {
    const a = await seedDeliveryWorkspace(h.deps.db, { platform: 'webhook', chatId: 'smoke' });
    const b = await seedDeliveryWorkspace(h.deps.db, { platform: 'webhook', chatId: 'smoke' });
    expect(a.workspaceId).not.toBe(b.workspaceId);
    const conn = (
      await h.ownerPool.query('select platform, kind, config_enc from connections where id = $1', [
        a.connectionId,
      ])
    ).rows[0];
    expect(conn).toMatchObject({ platform: 'webhook', kind: 'webhook', config_enc: null });
  });
});
