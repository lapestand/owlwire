-- Tenant isolation for source_templates, generated with tenantPolicySql (src/rls-sql.ts). It ships in the same
-- migrate run as the migration that creates the table. No FORCE ROW LEVEL SECURITY: the table owner bypasses RLS.
ALTER TABLE "source_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "source_templates_tenant_isolation" ON "source_templates"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
