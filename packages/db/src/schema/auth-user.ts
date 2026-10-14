import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './types.js';

/** Better Auth user. Instance-level: no workspace_id and no tenant RLS (the auth adapter runs outside any scope). */
export const authUser = pgTable(
  'auth_user',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    isInstanceAdmin: boolean('is_instance_admin').notNull().default(false),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Same rule as invitations.email. Better Auth lower-cases emails with JS toLowerCase() before every write and
    // lookup, and our own writes must normalise the same way in application code. Postgres lower() follows the
    // database collation and can disagree with JS for some non-ASCII characters, so this CHECK is a backstop
    // against mixed-case writes, not the normaliser.
    check('auth_user_email_lower_check', sql`${t.email} = lower(${t.email})`),
  ],
);
