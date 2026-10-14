CREATE INDEX "apps_name_idx" ON "apps" ("name");--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "nickname" text NOT NULL;
