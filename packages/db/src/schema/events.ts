import type { Message } from '@owlwire/core/message';
import { jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { installations } from './installations.js';
import { tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installations.id),
    idempotencyKey: text('idempotency_key').notNull(),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    message: jsonb('message').$type<Message>().notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    routedAt: tstz('routed_at'),
  },
  (t) => [unique('events_installation_idempotency_uq').on(t.installationId, t.idempotencyKey)],
);
