import { AUTH_TABLES } from '../auth-tables.js';

export { AUTH_TABLES };

/**
 * Why the Better Auth tables have no workspace_id and no RLS. Users, sessions and credentials belong to the
 * instance, not to a workspace (a user reaches a workspace only through memberships), and the auth adapter reads
 * and writes them outside any tenant or system scope, so a system-only policy would break sign-up and sign-in. The secret-bearing tables are
 * protected by grants instead: only the auth role can read them.
 */
const AUTH_TABLES_EXEMPTION =
  'Better Auth table: instance-level, no workspace; the auth adapter uses it outside any tenant or system scope, so a system-only policy would break sign-up and sign-in';

export const authTableExemptions = (): Record<string, string> =>
  Object.fromEntries(AUTH_TABLES.map((table) => [table, AUTH_TABLES_EXEMPTION]));
