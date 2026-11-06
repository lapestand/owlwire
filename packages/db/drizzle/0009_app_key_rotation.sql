ALTER TABLE "apps" ADD COLUMN "app_key_prev_hash" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "app_key_prev_prefix" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "app_key_prev_expires_at" timestamp with time zone;--> statement-breakpoint
-- apps holds a handful of rows per workspace, so the write lock while the index builds lasts milliseconds.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "apps_app_key_hash_uq" ON "apps" USING btree ("app_key_hash");--> statement-breakpoint
-- apps holds a handful of rows per workspace, so the write lock while the index builds lasts milliseconds.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "apps_app_key_prev_hash_uq" ON "apps" USING btree ("app_key_prev_hash");