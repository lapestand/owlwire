-- Tenant isolation for the membership and invitation tables, generated with tenantPolicySql (src/rls-sql.ts).
-- It ships in the same migrate run as the migration that creates the tables, so they are never readable across
-- workspaces. No FORCE ROW LEVEL SECURITY: the table owner (migrations) bypasses RLS on purpose.
-- The auth_* tables from the previous migration get no policy: they are instance-level (no workspace_id), and
-- Better Auth's adapter reads and writes them outside any tenant or system scope.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "memberships_tenant_isolation" ON "memberships"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "invitations_tenant_isolation" ON "invitations"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
