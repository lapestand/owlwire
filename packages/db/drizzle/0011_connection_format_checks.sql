ALTER TABLE "connections" DROP CONSTRAINT "connections_platform_check";--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_kind_check";--> statement-breakpoint
-- Added NOT VALID and validated right after, so the scan runs under a weaker lock; every existing value (telegram, discord, whatsapp, webhook, shared_bot, own_bot, number) matches the new format.
ALTER TABLE "connections" ADD CONSTRAINT "connections_platform_format_check" CHECK ("connections"."platform" ~ '^[a-z][a-z0-9-]{1,31}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_kind_format_check" CHECK ("connections"."kind" ~ '^[a-z][a-z0-9_]{1,31}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "connections" VALIDATE CONSTRAINT "connections_platform_format_check";--> statement-breakpoint
ALTER TABLE "connections" VALIDATE CONSTRAINT "connections_kind_format_check";
