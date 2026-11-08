ALTER TABLE "ObjectiveMessage" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ObjectiveSession" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "OperatorInputReceipt" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "OverlapWarning" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "TagDigestDelivery" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "TagMailboxCredential" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "TagMessage" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "TaskAssignment" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "TeamLiveDelivery" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "TeamReplyTrigger" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "Team" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "WorkstreamPost" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "Workstream" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "ObjectiveMessage" CASCADE;--> statement-breakpoint
DROP TABLE "ObjectiveSession" CASCADE;--> statement-breakpoint
DROP TABLE "OperatorInputReceipt" CASCADE;--> statement-breakpoint
DROP TABLE "OverlapWarning" CASCADE;--> statement-breakpoint
DROP TABLE "TagDigestDelivery" CASCADE;--> statement-breakpoint
DROP TABLE "TagMailboxCredential" CASCADE;--> statement-breakpoint
DROP TABLE "TagMessage" CASCADE;--> statement-breakpoint
DROP TABLE "TaskAssignment" CASCADE;--> statement-breakpoint
DROP TABLE "TeamLiveDelivery" CASCADE;--> statement-breakpoint
DROP TABLE "TeamReplyTrigger" CASCADE;--> statement-breakpoint
DROP TABLE "Team" CASCADE;--> statement-breakpoint
DROP TABLE "WorkstreamPost" CASCADE;--> statement-breakpoint
DROP TABLE "Workstream" CASCADE;--> statement-breakpoint
ALTER TABLE "Task" RENAME COLUMN "surfaceObjectiveId" TO "objectiveId";--> statement-breakpoint
DROP INDEX "Role_systemKey_key";--> statement-breakpoint
ALTER TABLE "Session" ADD COLUMN "objectiveId" text;--> statement-breakpoint
ALTER TABLE "Session" ADD CONSTRAINT "Session_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Session_objectiveId_idx" ON "Session" USING btree ("objectiveId");--> statement-breakpoint
ALTER TABLE "Objective" DROP COLUMN "observations";--> statement-breakpoint
ALTER TABLE "Objective" DROP COLUMN "observationState";--> statement-breakpoint
ALTER TABLE "Objective" DROP COLUMN "spentMinor";--> statement-breakpoint
ALTER TABLE "Objective" DROP COLUMN "reservedMinor";--> statement-breakpoint
ALTER TABLE "Role" DROP COLUMN "origin";--> statement-breakpoint
ALTER TABLE "Role" DROP COLUMN "systemKey";--> statement-breakpoint
ALTER TABLE "TagMessagingGrant" DROP COLUMN "messageTypes";