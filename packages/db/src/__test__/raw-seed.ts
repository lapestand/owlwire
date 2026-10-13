import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface RawTenant {
  workspaceId: string;
  connectionId: string;
  destinationId: string;
  appId: string;
  installationId: string;
  ruleId: string;
  ruleTargetId: string;
  audienceId: string;
  eventId: string;
  digestId: string;
  deliveryId: string;
  auditId: string;
}

export async function seedRawTenant(owner: pg.Pool, label: string): Promise<RawTenant> {
  const t: RawTenant = {
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
    destinationId: randomUUID(),
    appId: randomUUID(),
    installationId: randomUUID(),
    ruleId: randomUUID(),
    ruleTargetId: randomUUID(),
    audienceId: randomUUID(),
    eventId: randomUUID(),
    digestId: randomUUID(),
    deliveryId: randomUUID(),
    auditId: randomUUID(),
  };
  const q = (text: string, values: unknown[]) => owner.query(text, values);
  await q("insert into workspaces (id, name, slug, kind) values ($1, $2, $3, 'community')", [
    t.workspaceId,
    label,
    `${label}-${t.workspaceId}`,
  ]);
  await q(
    "insert into connections (id, workspace_id, platform, kind, display_name) values ($1, $2, 'telegram', 'shared_bot', $3)",
    [t.connectionId, t.workspaceId, `${label} conn`],
  );
  await q(
    "insert into destinations (id, workspace_id, connection_id, kind, external_id, name) values ($1, $2, $3, 'group', $4, $5)",
    [t.destinationId, t.workspaceId, t.connectionId, `ext-${t.destinationId}`, `${label} dest`],
  );
  await q(
    "insert into apps (id, owner_workspace_id, name, slug, visibility) values ($1, $2, $3, $4, 'private')",
    [t.appId, t.workspaceId, `${label} app`, `app-${t.appId}`],
  );
  await q(
    'insert into installations (id, app_id, workspace_id, token_hash, token_prefix) values ($1, $2, $3, $4, $5)',
    [t.installationId, t.appId, t.workspaceId, `hash-${t.installationId}`, 'ow_inst_test'],
  );
  await q(
    "insert into rules (id, workspace_id, installation_id, name, types) values ($1, $2, $3, 'r', array['*'])",
    [t.ruleId, t.workspaceId, t.installationId],
  );
  await q('insert into audiences (id, workspace_id, name) values ($1, $2, $3)', [
    t.audienceId,
    t.workspaceId,
    'aud',
  ]);
  await q(
    'insert into rule_targets (id, workspace_id, rule_id, destination_id) values ($1, $2, $3, $4)',
    [t.ruleTargetId, t.workspaceId, t.ruleId, t.destinationId],
  );
  await q(
    'insert into audience_members (audience_id, destination_id, workspace_id) values ($1, $2, $3)',
    [t.audienceId, t.destinationId, t.workspaceId],
  );
  await q(
    "insert into events (id, workspace_id, installation_id, idempotency_key, type, severity, message) values ($1, $2, $3, 'k1', 'generic', 'info', '{}'::jsonb)",
    [t.eventId, t.workspaceId, t.installationId],
  );
  await q(
    "insert into digests (id, workspace_id, destination_id, connection_id, window_start, window_end) values ($1, $2, $3, $4, now(), now() + interval '1 minute')",
    [t.digestId, t.workspaceId, t.destinationId, t.connectionId],
  );
  await q(
    'insert into deliveries (id, workspace_id, event_id, destination_id, connection_id) values ($1, $2, $3, $4, $5)',
    [t.deliveryId, t.workspaceId, t.eventId, t.destinationId, t.connectionId],
  );
  await q(
    'insert into connection_counters (connection_id, workspace_id, day) values ($1, $2, current_date)',
    [t.connectionId, t.workspaceId],
  );
  await q(
    "insert into workspace_keys (workspace_id, wrapped_dek, kek_version) values ($1, '\\x00'::bytea, 1)",
    [t.workspaceId],
  );
  await q(
    "insert into audit_log (id, workspace_id, action, target_type, target_id) values ($1, $2, 'workspace.created', 'workspace', $3)",
    [t.auditId, t.workspaceId, t.workspaceId],
  );
  await q("insert into catalog_types (app_id, key, name) values ($1, 'generic', 'Generic')", [
    t.appId,
  ]);
  return t;
}
