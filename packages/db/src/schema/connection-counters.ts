import { date, foreignKey, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { connections } from './connections.js';

export const connectionCounters = pgTable(
  'connection_counters',
  {
    connectionId: uuid('connection_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'connection_counters_pk', columns: [t.connectionId, t.day] }),
    foreignKey({
      name: 'connection_counters_connection_ws_fk',
      columns: [t.connectionId, t.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }).onDelete('cascade'),
  ],
);
