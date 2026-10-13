CREATE SCHEMA IF NOT EXISTS owlwire_private;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION owlwire_private.rls_allows(ws uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT coalesce(current_setting('owlwire.system', true), '') = 'on'
      OR ws = nullif(current_setting('owlwire.workspace_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspaces_tenant_isolation" ON "workspaces"
  USING (owlwire_private.rls_allows(id)) WITH CHECK (owlwire_private.rls_allows(id));
--> statement-breakpoint
ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "connections_tenant_isolation" ON "connections"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "destinations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "destinations_tenant_isolation" ON "destinations"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "installations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "installations_tenant_isolation" ON "installations"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rules_tenant_isolation" ON "rules"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "rule_targets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rule_targets_tenant_isolation" ON "rule_targets"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "events_tenant_isolation" ON "events"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "deliveries_tenant_isolation" ON "deliveries"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "workspace_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_keys_tenant_isolation" ON "workspace_keys"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "audiences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audiences_tenant_isolation" ON "audiences"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "audience_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audience_members_tenant_isolation" ON "audience_members"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "digests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "digests_tenant_isolation" ON "digests"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "connection_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "connection_counters_tenant_isolation" ON "connection_counters"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_log_tenant_isolation" ON "audit_log"
  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));
--> statement-breakpoint
ALTER TABLE "apps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "apps_select" ON "apps" FOR SELECT
  USING ((visibility = 'public' AND approval_status = 'approved') OR owlwire_private.rls_allows(owner_workspace_id));
--> statement-breakpoint
CREATE POLICY "apps_insert" ON "apps" FOR INSERT
  WITH CHECK (owlwire_private.rls_allows(owner_workspace_id));
--> statement-breakpoint
CREATE POLICY "apps_update" ON "apps" FOR UPDATE
  USING (owlwire_private.rls_allows(owner_workspace_id)) WITH CHECK (owlwire_private.rls_allows(owner_workspace_id));
--> statement-breakpoint
CREATE POLICY "apps_delete" ON "apps" FOR DELETE
  USING (owlwire_private.rls_allows(owner_workspace_id));
--> statement-breakpoint
ALTER TABLE "catalog_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "catalog_types_select" ON "catalog_types" FOR SELECT
  USING (EXISTS (SELECT 1 FROM apps a WHERE a.id = catalog_types.app_id));
--> statement-breakpoint
CREATE POLICY "catalog_types_write" ON "catalog_types" FOR ALL
  USING (EXISTS (SELECT 1 FROM apps a WHERE a.id = catalog_types.app_id AND owlwire_private.rls_allows(a.owner_workspace_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM apps a WHERE a.id = catalog_types.app_id AND owlwire_private.rls_allows(a.owner_workspace_id)));
