import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { connections } from './connections.js';
import { tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const destinations = pgTable(
  'destinations',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id),
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    externalSubId: text('external_sub_id'),
    name: text('name').notNull(),
    consentStatus: text('consent_status').notNull().default('pending'),
    consentedAt: tstz('consented_at'),
    status: text('status').notNull().default('active'),
    statusReason: text('status_reason'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    check(
      'destinations_kind_check',
      sql`${t.kind} in ('group', 'community', 'dm', 'channel', 'topic', 'thread', 'forum_post', 'webhook')`,
    ),
    check(
      'destinations_consent_status_check',
      sql`${t.consentStatus} in ('pending', 'confirmed', 'revoked')`,
    ),
    check('destinations_status_check', sql`${t.status} in ('active', 'broken')`),
    uniqueIndex('destinations_connection_external_uq').on(
      t.connectionId,
      t.externalId,
      sql`coalesce(${t.externalSubId}, '')`,
    ),
    unique('destinations_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      name: 'destinations_connection_ws_fk',
      columns: [t.connectionId, t.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }),
  ],
);
