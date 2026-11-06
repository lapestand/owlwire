CREATE TABLE "source_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"mapping" jsonb NOT NULL,
	"sample_payload" jsonb,
	"origin" text DEFAULT 'user' NOT NULL,
	"origin_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_templates_workspace_key_uq" UNIQUE("workspace_id","key"),
	CONSTRAINT "source_templates_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "source_templates_origin_check" CHECK ("source_templates"."origin" in ('user', 'pack'))
);
--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "source_template_id" uuid;--> statement-breakpoint
ALTER TABLE "source_templates" ADD CONSTRAINT "source_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- installations holds a few rows per workspace, the new column is all NULL, and the migration runs in one transaction, so NOT VALID + VALIDATE would buy nothing.
-- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
ALTER TABLE "installations" ADD CONSTRAINT "installations_source_template_ws_fk" FOREIGN KEY ("source_template_id","workspace_id") REFERENCES "public"."source_templates"("id","workspace_id") ON DELETE restrict ON UPDATE no action;