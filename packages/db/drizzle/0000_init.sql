CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"visibility" text NOT NULL,
	"approval_status" text DEFAULT 'approved' NOT NULL,
	"description" text,
	"homepage_url" text,
	"app_key_hash" text,
	"app_key_prefix" text,
	"status_webhook_url" text,
	"status_webhook_secret_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_slug_unique" UNIQUE("slug"),
	CONSTRAINT "apps_visibility_check" CHECK ("apps"."visibility" in ('private', 'public')),
	CONSTRAINT "apps_approval_status_check" CHECK ("apps"."approval_status" in ('approved', 'pending', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"config_enc" "bytea",
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"pacing" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_health_at" timestamp with time zone,
	CONSTRAINT "connections_platform_check" CHECK ("connections"."platform" in ('telegram', 'discord', 'whatsapp', 'webhook')),
	CONSTRAINT "connections_kind_check" CHECK ("connections"."kind" in ('shared_bot', 'own_bot', 'webhook', 'number')),
	CONSTRAINT "connections_status_check" CHECK ("connections"."status" in ('pending', 'active', 'degraded', 'broken', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"platform_message_id" text,
	"digest_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "deliveries_event_destination_uq" UNIQUE("event_id","destination_id"),
	CONSTRAINT "deliveries_status_check" CHECK ("deliveries"."status" in ('pending', 'scheduled', 'sending', 'delivered', 'failed', 'suppressed', 'digested'))
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"external_sub_id" text,
	"name" text NOT NULL,
	"consent_status" text DEFAULT 'pending' NOT NULL,
	"consented_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destinations_kind_check" CHECK ("destinations"."kind" in ('group', 'community', 'dm', 'channel', 'topic', 'thread', 'forum_post', 'webhook')),
	CONSTRAINT "destinations_consent_status_check" CHECK ("destinations"."consent_status" in ('pending', 'confirmed', 'revoked')),
	CONSTRAINT "destinations_status_check" CHECK ("destinations"."status" in ('active', 'broken'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"message" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"routed_at" timestamp with time zone,
	CONSTRAINT "events_installation_idempotency_uq" UNIQUE("installation_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"external_ref" text,
	"granted_types" text[],
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "installations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "installations_status_check" CHECK ("installations"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "rule_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"destination_id" uuid,
	"audience_id" uuid,
	CONSTRAINT "rule_targets_exactly_one_check" CHECK (("rule_targets"."destination_id" is null) <> ("rule_targets"."audience_id" is null))
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"types" text[] NOT NULL,
	"min_severity" text DEFAULT 'info' NOT NULL,
	"filter" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_min_severity_check" CHECK ("rules"."min_severity" in ('info', 'low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug"),
	CONSTRAINT "workspaces_kind_check" CHECK ("workspaces"."kind" in ('personal', 'community'))
);
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_workspace_id_workspaces_id_fk" FOREIGN KEY ("owner_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_targets" ADD CONSTRAINT "rule_targets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_targets" ADD CONSTRAINT "rule_targets_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_targets" ADD CONSTRAINT "rule_targets_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_created_at_idx" ON "deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "destinations_connection_external_uq" ON "destinations" USING btree ("connection_id","external_id",coalesce("external_sub_id", ''));--> statement-breakpoint
CREATE INDEX "rules_installation_idx" ON "rules" USING btree ("installation_id");