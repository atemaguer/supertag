CREATE TABLE "TeamReplyTrigger" (
	"id" text PRIMARY KEY NOT NULL,
	"objectiveId" text NOT NULL,
	"teamId" text NOT NULL,
	"senderTagId" text NOT NULL,
	"recipientTagId" text NOT NULL,
	"itemKind" text NOT NULL,
	"itemId" text NOT NULL,
	"itemType" text NOT NULL,
	"sourceTaskId" text,
	"taskId" text,
	"status" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ALTER COLUMN "authorTagId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "TaskAssignment" ADD COLUMN "activationKind" text;--> statement-breakpoint
ALTER TABLE "TeamReplyTrigger" ADD CONSTRAINT "TeamReplyTrigger_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamReplyTrigger" ADD CONSTRAINT "TeamReplyTrigger_teamId_Team_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamReplyTrigger" ADD CONSTRAINT "TeamReplyTrigger_senderTagId_Tag_id_fk" FOREIGN KEY ("senderTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamReplyTrigger" ADD CONSTRAINT "TeamReplyTrigger_recipientTagId_Tag_id_fk" FOREIGN KEY ("recipientTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamReplyTrigger" ADD CONSTRAINT "TeamReplyTrigger_sourceTaskId_Task_id_fk" FOREIGN KEY ("sourceTaskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamReplyTrigger" ADD CONSTRAINT "TeamReplyTrigger_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "TeamReplyTrigger_item_recipient_key" ON "TeamReplyTrigger" USING btree ("itemKind","itemId","recipientTagId");--> statement-breakpoint
CREATE INDEX "TeamReplyTrigger_status_created_idx" ON "TeamReplyTrigger" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "TeamReplyTrigger_recipient_objective_idx" ON "TeamReplyTrigger" USING btree ("recipientTagId","objectiveId","createdAt");--> statement-breakpoint
CREATE INDEX "TeamReplyTrigger_task_idx" ON "TeamReplyTrigger" USING btree ("taskId");