/** The Better Auth tables. Shared by the RLS coverage and cross-tenant tests so their exemptions cannot drift. */
export const AUTH_TABLES = [
  'auth_user',
  'auth_session',
  'auth_account',
  'auth_verification',
  'auth_two_factor',
  'auth_passkey',
  'auth_rate_limit',
] as const;

/**
 * Why the Better Auth tables have no workspace_id and no RLS. Users, sessions and credentials belong to the
 * instance, not to a workspace (a user reaches a workspace only through memberships), and the auth adapter reads
 * and writes them outside any tenant or system scope, so a system-only policy would break sign-up and sign-in.
 */
const AUTH_TABLES_EXEMPTION =
  'Better Auth table: instance-level, no workspace; the auth adapter uses it outside any tenant or system scope, so a system-only policy would break sign-up and sign-in';

export const authTableExemptions = (): Record<string, string> =>
  Object.fromEntries(AUTH_TABLES.map((table) => [table, AUTH_TABLES_EXEMPTION]));
