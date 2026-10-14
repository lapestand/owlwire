-- RLS lets an owning tenant write any column of its own app, so moderation
-- of public apps is also enforced here. Rules, unless system mode (owlwire.system = 'on') or RLS does not apply
-- to the current role (table owner / migration role, which bypasses RLS anyway):
--   * a tenant never writes an approval that moderation did not grant: an INSERT of a public app that starts
--     'approved', or any UPDATE that changes approval_status, raises 42501 (insufficient_privilege);
--   * a visibility change is a legitimate tenant action and is not rejected; flipping private -> public resets
--     an 'approved' status to 'pending' so the app enters moderation ('pending'/'rejected' are kept).
-- SECURITY INVOKER (the default): owlwire_private must not contain SECURITY DEFINER functions.
CREATE OR REPLACE FUNCTION owlwire_private.apps_approval_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER
AS $$
BEGIN
  IF coalesce(current_setting('owlwire.system', true), '') = 'on' OR NOT row_security_active(TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.visibility = 'public' AND NEW.approval_status = 'approved' THEN
      RAISE EXCEPTION 'a public app cannot be created as approved'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    RAISE EXCEPTION 'approval_status can only be changed by the instance (system mode)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.visibility = 'private' AND NEW.visibility = 'public' AND NEW.approval_status = 'approved' THEN
    NEW.approval_status := 'pending';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "apps_approval_guard" BEFORE INSERT OR UPDATE ON "apps"
  FOR EACH ROW EXECUTE FUNCTION owlwire_private.apps_approval_guard();
--> statement-breakpoint
-- instance_settings is instance-level: only system transactions may read or write it. rls_allows(NULL) is the
-- system-only form of the tenant predicate (NULL never equals the tenant's workspace id).
ALTER TABLE "instance_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "instance_settings_system_only" ON "instance_settings"
  USING (owlwire_private.rls_allows(NULL)) WITH CHECK (owlwire_private.rls_allows(NULL));
