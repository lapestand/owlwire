import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, uuid } from 'drizzle-orm/pg-core';
import { audiences } from './audiences.js';
import { destinations } from './destinations.js';
import { rules } from './rules.js';
import { workspaces } from './workspaces.js';

export const ruleTargets = pgTable(
  'rule_targets',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    destinationId: uuid('destination_id').references(() => destinations.id),
    audienceId: uuid('audience_id'),
  },
  (t) => [
    check(
      'rule_targets_exactly_one_check',
      sql`(${t.destinationId} is null) <> (${t.audienceId} is null)`,
    ),
    foreignKey({
      name: 'rule_targets_rule_ws_fk',
      columns: [t.ruleId, t.workspaceId],
      foreignColumns: [rules.id, rules.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'rule_targets_destination_ws_fk',
      columns: [t.destinationId, t.workspaceId],
      foreignColumns: [destinations.id, destinations.workspaceId],
    }),
    foreignKey({
      name: 'rule_targets_audience_ws_fk',
      columns: [t.audienceId, t.workspaceId],
      foreignColumns: [audiences.id, audiences.workspaceId],
    }),
  ],
);
