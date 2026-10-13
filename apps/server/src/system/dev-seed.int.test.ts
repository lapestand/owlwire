import { verifyTokenHash } from '@owlwire/crypto';
import { connections, destinations, installations, rules, ruleTargets } from '@owlwire/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test/harness.js';
import { seedDevWorkspace } from './dev-seed.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('seedDevWorkspace', () => {
  it('creates a full telegram route with an encrypted bot token', async () => {
    const r = await seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
      platform: 'telegram',
      botToken: '123:ABC',
      chatId: '-1001234',
    });
    const [inst] = await h.deps.db
      .select()
      .from(installations)
      .where(eq(installations.id, r.installationId));
    expect(inst && verifyTokenHash(r.token, inst.tokenHash)).toBe(true);
    expect(inst?.tokenPrefix).toBe(r.token.slice(0, 12));

    const [conn] = await h.deps.db
      .select()
      .from(connections)
      .where(eq(connections.id, r.connectionId));
    expect(conn).toMatchObject({ platform: 'telegram', kind: 'own_bot', status: 'active' });
    expect(conn?.configEnc && h.deps.crypto.open(conn.configEnc)).toEqual({ botToken: '123:ABC' });

    const [dest] = await h.deps.db
      .select()
      .from(destinations)
      .where(eq(destinations.id, r.destinationId));
    expect(dest).toMatchObject({
      kind: 'group',
      externalId: '-1001234',
      consentStatus: 'confirmed',
    });

    const [rule] = await h.deps.db.select().from(rules).where(eq(rules.id, r.ruleId));
    expect(rule?.types).toEqual(['*']);
    const targets = await h.deps.db
      .select()
      .from(ruleTargets)
      .where(eq(ruleTargets.ruleId, r.ruleId));
    expect(targets.map((t) => t.destinationId)).toEqual([r.destinationId]);
  });

  it('creates a fake webhook route without config and can run twice', async () => {
    const a = await seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
      platform: 'webhook',
      chatId: 'smoke',
    });
    const b = await seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
      platform: 'webhook',
      chatId: 'smoke',
    });
    expect(a.workspaceId).not.toBe(b.workspaceId);
    const [conn] = await h.deps.db
      .select()
      .from(connections)
      .where(eq(connections.id, a.connectionId));
    expect(conn).toMatchObject({ platform: 'webhook', kind: 'webhook', configEnc: null });
  });

  it('requires a bot token for telegram and a chat id', async () => {
    await expect(
      seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
        platform: 'telegram',
        chatId: '1',
      }),
    ).rejects.toThrow(/--bot-token/);
    await expect(
      seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
        platform: 'webhook',
        chatId: ' ',
      }),
    ).rejects.toThrow(/--chat-id/);
  });
});
