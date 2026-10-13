import { type SQL, sql } from 'drizzle-orm';

/** Schemas the application role may use. drizzle's migration table ("drizzle" schema) is left out on purpose. */
export const APP_SCHEMAS = ['public', 'owlwire_private', 'graphile_worker'] as const;

/**
 * Ways a role escapes row level security. A role's own flags are not enough: a member of a SUPERUSER or BYPASSRLS
 * role can SET ROLE to it, and a role that owns a relation or schema in the app schemas (directly or through
 * membership) is not subject to RLS on it or can change it.
 */
export interface RlsSubjectFlags {
  isSuper: boolean;
  bypassRls: boolean;
  /** Member of the role running the check (the migration owner in `ensureAppRole`; always false for `current_user`). */
  ownerMember: boolean;
  /** Member of another SUPERUSER or BYPASSRLS role. Meaningless for a superuser (it is a member of every role). */
  privilegedMember: boolean;
  /** Owns a relation in the app schemas itself. */
  ownsRelationDirectly: boolean;
  /** Owns a relation in the app schemas directly or through membership. */
  ownsRelation: boolean;
  /** Owns one of the app schemas directly or through membership. */
  ownsSchema: boolean;
}

/**
 * Read-only check shared by `ensureAppRole` (owner connection, `role` = the app role name) and the startup check
 * (`role = null`: the connection's own `current_user`). One row, or none when the role does not exist.
 */
export function rlsSubjectQuery(role: string | null): SQL {
  const subject = role === null ? sql`current_user` : sql`${role}::name`;
  const schemas = sql`${sql.param([...APP_SCHEMAS])}::text[]`;
  return sql`select
      r.rolsuper as "isSuper",
      r.rolbypassrls as "bypassRls",
      (r.rolname <> current_user and pg_has_role(r.oid, current_user, 'MEMBER')) as "ownerMember",
      exists (
        select 1 from pg_roles p
        where (p.rolsuper or p.rolbypassrls) and p.oid <> r.oid and pg_has_role(r.oid, p.oid, 'MEMBER')
      ) as "privilegedMember",
      exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any(${schemas}) and c.relowner = r.oid
      ) as "ownsRelationDirectly",
      exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any(${schemas}) and pg_has_role(r.oid, c.relowner, 'MEMBER')
      ) as "ownsRelation",
      exists (
        select 1 from pg_namespace n
        where n.nspname = any(${schemas}) and pg_has_role(r.oid, n.nspowner, 'MEMBER')
      ) as "ownsSchema"
    from pg_roles r
    where r.rolname = ${subject}`;
}

/** Startup wording of the flags; membership-derived reasons are skipped for a superuser (it is a member of every role). */
export function rlsBypassReasons(flags: RlsSubjectFlags): string[] {
  const reasons: string[] = [];
  if (flags.isSuper) reasons.push('application role is SUPERUSER');
  if (flags.bypassRls) reasons.push('application role has BYPASSRLS');
  if (flags.ownsRelationDirectly) reasons.push('application role owns the tables');
  if (flags.isSuper) return reasons;
  if (flags.ownerMember) reasons.push('application role is a member of the table owner role');
  if (flags.privilegedMember) {
    reasons.push('application role is a member of a SUPERUSER or BYPASSRLS role');
  }
  if (flags.ownsRelation && !flags.ownsRelationDirectly) {
    reasons.push('application role is a member of a role that owns the tables');
  }
  if (flags.ownsSchema) {
    reasons.push(`application role owns a schema among ${APP_SCHEMAS.join(', ')}`);
  }
  return reasons;
}
