import { foreignKey, index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { audiences } from './audiences.js';
import { destinations } from './destinations.js';

export const audienceMembers = pgTable(
  'audience_members',
  {
    audienceId: uuid('audience_id').notNull(),
    destinationId: uuid('destination_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'audience_members_pk', columns: [t.audienceId, t.destinationId] }),
    foreignKey({
      name: 'audience_members_audience_ws_fk',
      columns: [t.audienceId, t.workspaceId],
      foreignColumns: [audiences.id, audiences.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'audience_members_destination_ws_fk',
      columns: [t.destinationId, t.workspaceId],
      foreignColumns: [destinations.id, destinations.workspaceId],
    }).onDelete('cascade'),
    index('audience_members_destination_idx').on(t.destinationId),
  ],
);
