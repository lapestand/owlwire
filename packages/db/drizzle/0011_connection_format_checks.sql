-- The closed platform list is replaced by a format check in this same transaction, so there is no window without a check.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "connections" DROP CONSTRAINT "connections_platform_check";--> statement-breakpoint
-- The closed kind list is replaced by a format check in this same transaction, so there is no window without a check.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "connections" DROP CONSTRAINT "connections_kind_check";--> statement-breakpoint
-- Every existing platform value (telegram, discord, whatsapp, webhook) matches the format; connections holds a few rows per workspace and the migration runs in one transaction, so a NOT VALID step would buy nothing.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "connections" ADD CONSTRAINT "connections_platform_format_check" CHECK ("connections"."platform" ~ '^[a-z][a-z0-9-]{1,31}$');--> statement-breakpoint
-- Every existing kind value (shared_bot, own_bot, webhook, number) matches the format; same small table and single transaction as above.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "connections" ADD CONSTRAINT "connections_kind_format_check" CHECK ("connections"."kind" ~ '^[a-z][a-z0-9_]{1,31}$');
