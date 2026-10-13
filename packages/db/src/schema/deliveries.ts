import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { connections } from './connections.js';
import { destinations } from './destinations.js';
import { events } from './events.js';
import { tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => destinations.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at'),
    lastError: text('last_error'),
    platformMessageId: text('platform_message_id'),
    digestId: uuid('digest_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    deliveredAt: tstz('delivered_at'),
  },
  (t) => [
    check(
      'deliveries_status_check',
      sql`${t.status} in ('pending', 'scheduled', 'sending', 'delivered', 'failed', 'suppressed', 'digested')`,
    ),
    unique('deliveries_event_destination_uq').on(t.eventId, t.destinationId),
    index('deliveries_created_at_idx').on(t.createdAt),
  ],
);
