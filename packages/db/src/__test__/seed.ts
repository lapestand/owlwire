import { randomUUID } from 'node:crypto';
import { newId } from '@owlwire/core';
import { sql } from 'drizzle-orm';
import type { OwlwireDb } from '../handle.js';
import { createApp } from '../repos/apps.js';
import { createAudience, setAudienceMembers } from '../repos/audiences.js';
import { SYSTEM_ACTOR } from '../repos/audit.js';
import { createConnection } from '../repos/connections.js';
import { q } from '../repos/context.js';
import { createDeliveries } from '../repos/deliveries.js';
import { createDestination } from '../repos/destinations.js';
import { insertEvent } from '../repos/events.js';
import { createInstallation } from '../repos/installations.js';
import { createRule } from '../repos/rules.js';
import { tenantScope, withTenant } from '../scope.js';
import { createTestWorkspace } from './fixtures.js';

/**
 * One fully populated workspace, built through the tenant repository functions where they exist and raw inserts
 * (app role, own scope) where no repository writes the table yet.
 */
export interface SeededTenant {
  workspaceId: string;
  connectionId: string;
  destinationId: string;
  audienceId: string;
  appId: string;
  installationId: string;
  ruleId: string;
  eventId: string;
  deliveryId: string;
  digestId: string;
  /** Instance-level auth_user row, owner of the workspace through a membership. */
  userId: string;
  invitationId: string;
  invitationEmail: string;
  secret: string;
}

export async function seedTenant(db: OwlwireDb, label: string): Promise<SeededTenant> {
  const workspaceId = await createTestWorkspace(db, label);
  const secret = `${label}-secret-token-${randomUUID()}`;
  return withTenant(db, tenantScope(workspaceId), async (t) => {
    const conn = await createConnection(
      t,
      { platform: 'telegram', kind: 'own_bot', displayName: label, config: { botToken: secret } },
      SYSTEM_ACTOR,
    );
    const dest = await createDestination(t, {
      connectionId: conn.id,
      kind: 'group',
      externalId: `-100-${label}`,
      name: label,
      consentStatus: 'confirmed',
    });
    const aud = await createAudience(t, { name: `${label}-aud` }, SYSTEM_ACTOR);
    await setAudienceMembers(t, aud.id, [dest.id], SYSTEM_ACTOR);
    const app = await createApp(
      t,
      { name: label, slug: `${label}-${randomUUID()}`, visibility: 'private' },
      SYSTEM_ACTOR,
    );
    const inst = await createInstallation(
      t,
      { appId: app.id, tokenHash: randomUUID(), tokenPrefix: 'ow_inst_seed' },
      SYSTEM_ACTOR,
    );
    const rule = await createRule(
      t,
      {
        installationId: inst.id,
        name: label,
        types: ['*'],
        targets: [{ destinationId: dest.id }, { audienceId: aud.id }],
      },
      SYSTEM_ACTOR,
    );
    const ev = await insertEvent(t, {
      installationId: inst.id,
      idempotencyKey: `${label}-k`,
      type: 'generic',
      severity: 'info',
      message: { type: 'generic', severity: 'info', body: `${label} body` },
    });
    const [delivery] = await createDeliveries(t, ev.eventId, [
      { destinationId: dest.id, connectionId: conn.id },
    ]);
    if (!delivery) throw new Error('seed delivery missing');
    // No repository writes digests yet, connection counters or catalog types; raw rows (app role, own scope)
    // give the snapshot and the composite FK tests a real row in every workspace-owned table.
    const digestId = newId();
    await q(
      t,
    ).execute(sql`insert into digests (id, workspace_id, destination_id, connection_id, window_start, window_end)
      values (${digestId}, ${workspaceId}, ${dest.id}, ${conn.id}, now(), now() + interval '1 hour')`);
    await q(t).execute(sql`insert into connection_counters (connection_id, workspace_id, day, sent)
      values (${conn.id}, ${workspaceId}, '2026-10-12', 1)`);
    await q(t).execute(sql`insert into catalog_types (app_id, key, name)
      values (${app.id}, ${`${label}.type`}, ${label})`);
    // A user who owns the workspace and a pending invitation, so membership and invitation attacks have a target.
    const userId = newId();
    await q(t).execute(sql`insert into auth_user (id, name, email)
      values (${userId}, ${label}, ${`${label}-${userId}@seed.test`})`);
    await q(t).execute(sql`insert into memberships (workspace_id, user_id, role)
      values (${workspaceId}, ${userId}, 'owner')`);
    const invitationId = newId();
    const invitationEmail = `${label}-invitee-${invitationId}@seed.test`;
    await q(
      t,
    ).execute(sql`insert into invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
      values (${invitationId}, ${workspaceId}, ${invitationEmail}, 'member', ${`${label}-inv-${randomUUID()}`},
              ${userId}, now() + interval '7 days')`);
    return {
      workspaceId,
      connectionId: conn.id,
      destinationId: dest.id,
      audienceId: aud.id,
      appId: app.id,
      installationId: inst.id,
      ruleId: rule.id,
      eventId: ev.eventId,
      deliveryId: delivery.id,
      digestId,
      userId,
      invitationId,
      invitationEmail,
      secret,
    };
  });
}
