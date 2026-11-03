-- Workstreams become Team channels: one per Team, sharing the Team ID, with everything else read
-- from the Team. Ad-hoc Workstreams and their posts go away, and so do Workstream references on
-- Mailbox messages and Tasks.
-- Old Workstreams sharing a Team's ID keep only posts written in that Team's Objective by its
-- members; a Workstream from another Objective that reused the ID is dropped with its posts.
UPDATE "TaskAssignment" SET "workstreamId" = NULL
WHERE "workstreamId" IS NOT NULL AND "workstreamId" NOT IN (
	SELECT "Workstream"."id" FROM "Workstream" JOIN "Team" ON "Team"."id" = "Workstream"."id"
	WHERE "Workstream"."objectiveId" = "Team"."objectiveId"
);--> statement-breakpoint
DELETE FROM "WorkstreamPost" WHERE NOT EXISTS (
	SELECT 1 FROM "Workstream" JOIN "Team" ON "Team"."id" = "Workstream"."id"
	WHERE "Workstream"."id" = "WorkstreamPost"."workstreamId"
	AND "Workstream"."objectiveId" = "Team"."objectiveId"
	AND "Team"."memberTagIds" @> jsonb_build_array("WorkstreamPost"."authorTagId")
);--> statement-breakpoint
UPDATE "TagMessage" SET "workstreamId" = NULL WHERE "workstreamId" IS NOT NULL;--> statement-breakpoint
DELETE FROM "Workstream" WHERE NOT EXISTS (
	SELECT 1 FROM "Team" WHERE "Team"."id" = "Workstream"."id"
	AND "Team"."objectiveId" = "Workstream"."objectiveId"
);--> statement-breakpoint
ALTER TABLE "TagMessage" DROP CONSTRAINT "TagMessage_workstreamId_Workstream_id_fk";
--> statement-breakpoint
ALTER TABLE "Workstream" DROP CONSTRAINT "Workstream_ownerTagId_Tag_id_fk";
--> statement-breakpoint
DROP INDEX "TagMessage_workstream_created_idx";--> statement-breakpoint
DROP INDEX "Workstream_objective_idx";--> statement-breakpoint
DROP INDEX "Workstream_owner_idx";--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ADD COLUMN "type" text DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ADD COLUMN "to" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "Workstream" ADD CONSTRAINT "Workstream_id_Team_id_fk" FOREIGN KEY ("id") REFERENCES "public"."Team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessage" DROP COLUMN "workstreamId";--> statement-breakpoint
ALTER TABLE "Workstream" DROP COLUMN "objectiveId";--> statement-breakpoint
ALTER TABLE "Workstream" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "Workstream" DROP COLUMN "ownerTagId";--> statement-breakpoint
ALTER TABLE "Workstream" DROP COLUMN "participantTagIds";--> statement-breakpoint
ALTER TABLE "Workstream" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "Workstream" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "Workstream" DROP COLUMN "updatedAt";--> statement-breakpoint
INSERT INTO "Workstream" ("id", "createdAt")
SELECT "id", "createdAt" FROM "Team" WHERE "id" NOT IN (SELECT "id" FROM "Workstream");
