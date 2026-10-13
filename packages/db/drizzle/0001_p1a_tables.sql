CREATE TABLE "audience_members" (
	"audience_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "audience_members_pk" PRIMARY KEY("audience_id","destination_id")
);
--> statement-breakpoint
CREATE TABLE "audiences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audiences_workspace_name_uq" UNIQUE("workspace_id","name"),
	CONSTRAINT "audiences_id_workspace_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" uuid,
	"actor_installation_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_types" (
	"app_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_severity" text DEFAULT 'info' NOT NULL,
	"payload_schema" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_types_pk" PRIMARY KEY("app_id","key"),
	CONSTRAINT "catalog_types_default_severity_check" CHECK ("catalog_types"."default_severity" in ('info','low','medium','high','critical'))
);
--> statement-breakpoint
CREATE TABLE "connection_counters" (
	"connection_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "connection_counters_pk" PRIMARY KEY("connection_id","day")
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"delivery_count" integer DEFAULT 0 NOT NULL,
	"platform_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digests_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "digests_status_check" CHECK ("digests"."status" in ('open','sent','failed')),
	CONSTRAINT "digests_window_check" CHECK ("digests"."window_end" > "digests"."window_start")
);
--> statement-breakpoint
CREATE TABLE "rate_buckets" (
	"scope" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"capacity" double precision NOT NULL,
	"refill_per_sec" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_keys" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kek_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "workspace_keys_kek_version_check" CHECK ("workspace_keys"."kek_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "config_enc_scheme" text DEFAULT 'kek_v0' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "destinations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audience_members" ADD CONSTRAINT "audience_members_audience_ws_fk" FOREIGN KEY ("audience_id","workspace_id") REFERENCES "public"."audiences"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_members" ADD CONSTRAINT "audience_members_destination_ws_fk" FOREIGN KEY ("destination_id","workspace_id") REFERENCES "public"."destinations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audiences" ADD CONSTRAINT "audiences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_types" ADD CONSTRAINT "catalog_types_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_counters" ADD CONSTRAINT "connection_counters_connection_ws_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_destination_ws_fk" FOREIGN KEY ("destination_id","workspace_id") REFERENCES "public"."destinations"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_connection_ws_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audience_members_destination_idx" ON "audience_members" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "audit_log_workspace_created_idx" ON "audit_log" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "digests_destination_status_idx" ON "digests" USING btree ("destination_id","status");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_ws_fk" FOREIGN KEY ("event_id","workspace_id") REFERENCES "public"."events"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_destination_ws_fk" FOREIGN KEY ("destination_id","workspace_id") REFERENCES "public"."destinations"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_connection_ws_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_digest_ws_fk" FOREIGN KEY ("digest_id","workspace_id") REFERENCES "public"."digests"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_connection_ws_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_installation_ws_fk" FOREIGN KEY ("installation_id","workspace_id") REFERENCES "public"."installations"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_targets" ADD CONSTRAINT "rule_targets_rule_ws_fk" FOREIGN KEY ("rule_id","workspace_id") REFERENCES "public"."rules"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_targets" ADD CONSTRAINT "rule_targets_destination_ws_fk" FOREIGN KEY ("destination_id","workspace_id") REFERENCES "public"."destinations"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_targets" ADD CONSTRAINT "rule_targets_audience_ws_fk" FOREIGN KEY ("audience_id","workspace_id") REFERENCES "public"."audiences"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_installation_ws_fk" FOREIGN KEY ("installation_id","workspace_id") REFERENCES "public"."installations"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_config_enc_scheme_check" CHECK ("connections"."config_enc_scheme" in ('kek_v0','dek_v1'));