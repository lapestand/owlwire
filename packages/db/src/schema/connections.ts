import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    platform: text('platform').notNull(),
    kind: text('kind').notNull(),
    displayName: text('display_name').notNull(),
    configEnc: bytea('config_enc'),
    status: text('status').notNull().default('pending'),
    statusReason: text('status_reason'),
    pacing: jsonb('pacing'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    lastHealthAt: tstz('last_health_at'),
    configEncScheme: text('config_enc_scheme', { enum: ['kek_v0', 'dek_v1'] })
      .notNull()
      .default('dek_v1'),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    check('connections_platform_format_check', sql`${t.platform} ~ '^[a-z][a-z0-9-]{1,31}$'`),
    check('connections_kind_format_check', sql`${t.kind} ~ '^[a-z][a-z0-9_]{1,31}$'`),
    check(
      'connections_status_check',
      sql`${t.status} in ('pending', 'active', 'degraded', 'broken', 'paused')`,
    ),
    unique('connections_id_workspace_uq').on(t.id, t.workspaceId),
    check('connections_config_enc_scheme_check', sql`${t.configEncScheme} in ('kek_v0','dek_v1')`),
  ],
);
