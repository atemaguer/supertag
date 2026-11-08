ALTER TABLE "ArtifactPublicationApproval" DROP CONSTRAINT "ArtifactPublicationApproval_sourceTaskId_TaskAssignment_taskId_fk";
--> statement-breakpoint
ALTER TABLE "ResourceChange" DROP CONSTRAINT "ResourceChange_sourceMessageId_TagMessage_id_fk";
--> statement-breakpoint
DROP INDEX "ResourceChange_source_message_idx";--> statement-breakpoint
ALTER TABLE "ArtifactPublicationApproval" ADD CONSTRAINT "ArtifactPublicationApproval_sourceTaskId_Task_id_fk" FOREIGN KEY ("sourceTaskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ResourceChange" DROP COLUMN "sourceMessageId";