CREATE TABLE "Volume" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"credential" text,
	"revision" integer NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "TaskAttempt" ADD COLUMN "mountManifests" jsonb;--> statement-breakpoint
ALTER TABLE "Workspace" ADD COLUMN "mounts" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "Volume_name_key" ON "Volume" USING btree ("name");