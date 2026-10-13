import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { connections } from './connections.js';
import { destinations } from './destinations.js';
import { tstz } from './types.js';

export const digests = pgTable(
  'digests',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    destinationId: uuid('destination_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    windowStart: tstz('window_start').notNull(),
    windowEnd: tstz('window_end').notNull(),
    status: text('status', { enum: ['open', 'sent', 'failed'] })
      .notNull()
      .default('open'),
    deliveryCount: integer('delivery_count').notNull().default(0),
    platformMessageId: text('platform_message_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('digests_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      name: 'digests_destination_ws_fk',
      columns: [t.destinationId, t.workspaceId],
      foreignColumns: [destinations.id, destinations.workspaceId],
    }),
    foreignKey({
      name: 'digests_connection_ws_fk',
      columns: [t.connectionId, t.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }),
    check('digests_status_check', sql`${t.status} in ('open','sent','failed')`),
    check('digests_window_check', sql`${t.windowEnd} > ${t.windowStart}`),
    index('digests_destination_status_idx').on(t.destinationId, t.status),
  ],
);
