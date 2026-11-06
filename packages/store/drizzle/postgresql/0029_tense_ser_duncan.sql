ALTER TABLE "Session" ADD COLUMN "audience" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "Session" ADD COLUMN "audienceActorKey" text;