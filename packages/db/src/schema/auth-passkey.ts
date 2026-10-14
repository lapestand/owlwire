import { boolean, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth-user.js';
import { tstz } from './types.js';

export const authPasskey = pgTable(
  'auth_passkey',
  {
    id: uuid('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    // A WebAuthn credential id may be registered once; sign-in looks the credential up by it.
    credentialID: text('credential_id').notNull().unique(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    aaguid: text('aaguid'),
    createdAt: tstz('created_at'),
  },
  (t) => [index('auth_passkey_user_id_idx').on(t.userId)],
);
