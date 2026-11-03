CREATE TABLE "TeamLiveDelivery" (
	"id" text PRIMARY KEY NOT NULL,
	"objectiveId" text NOT NULL,
	"teamId" text NOT NULL,
	"taskId" text NOT NULL,
	"attemptId" text NOT NULL,
	"senderTagId" text NOT NULL,
	"recipientTagId" text NOT NULL,
	"itemKind" text NOT NULL,
	"itemId" text NOT NULL,
	"itemType" text NOT NULL,
	"status" text NOT NULL,
	"truncated" boolean NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "TeamLiveDelivery" ADD CONSTRAINT "TeamLiveDelivery_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamLiveDelivery" ADD CONSTRAINT "TeamLiveDelivery_teamId_Team_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamLiveDelivery" ADD CONSTRAINT "TeamLiveDelivery_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamLiveDelivery" ADD CONSTRAINT "TeamLiveDelivery_attemptId_TaskAttempt_id_fk" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskAttempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamLiveDelivery" ADD CONSTRAINT "TeamLiveDelivery_senderTagId_Tag_id_fk" FOREIGN KEY ("senderTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TeamLiveDelivery" ADD CONSTRAINT "TeamLiveDelivery_recipientTagId_Tag_id_fk" FOREIGN KEY ("recipientTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "TeamLiveDelivery_item_key" ON "TeamLiveDelivery" USING btree ("recipientTagId","objectiveId","itemKind","itemId");--> statement-breakpoint
CREATE INDEX "TeamLiveDelivery_pair_idx" ON "TeamLiveDelivery" USING btree ("attemptId","senderTagId");--> statement-breakpoint
CREATE INDEX "TeamLiveDelivery_objective_idx" ON "TeamLiveDelivery" USING btree ("objectiveId","createdAt");