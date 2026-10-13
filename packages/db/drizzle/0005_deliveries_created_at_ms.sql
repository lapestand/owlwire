ALTER TABLE "deliveries" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ALTER COLUMN "created_at" SET DEFAULT now();