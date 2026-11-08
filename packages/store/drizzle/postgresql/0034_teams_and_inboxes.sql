CREATE TABLE "OverlapWarning" (
	"objectiveId" text NOT NULL,
	"lowerAttemptId" text NOT NULL,
	"higherAttemptId" text NOT NULL,
	"path" text NOT NULL,
	CONSTRAINT "OverlapWarning_objectiveId_lowerAttemptId_higherAttemptId_path_pk" PRIMARY KEY("objectiveId","lowerAttemptId","higherAttemptId","path")
);
--> statement-breakpoint
CREATE TABLE "TagMessage" (
	"id" text PRIMARY KEY NOT NULL,
	"senderTagId" text NOT NULL,
	"recipientTagId" text NOT NULL,
	"objectiveId" text,
	"sourceTaskId" text,
	"workstreamPostId" text,
	"text" text NOT NULL,
	"hops" integer DEFAULT 0 NOT NULL,
	"taskId" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Team" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"memberTagIds" jsonb NOT NULL,
	"maxConcurrency" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WorkstreamPost" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"authorTagId" text NOT NULL,
	"sourceTaskId" text,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body" text NOT NULL,
	"sequence" integer NOT NULL,
	"createdAt" text NOT NULL,
	"idempotencyKey" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Objective" ADD COLUMN "teamId" text;--> statement-breakpoint
ALTER TABLE "TagMessage" ADD CONSTRAINT "TagMessage_senderTagId_Tag_id_fk" FOREIGN KEY ("senderTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessage" ADD CONSTRAINT "TagMessage_recipientTagId_Tag_id_fk" FOREIGN KEY ("recipientTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessage" ADD CONSTRAINT "TagMessage_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessage" ADD CONSTRAINT "TagMessage_sourceTaskId_Task_id_fk" FOREIGN KEY ("sourceTaskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessage" ADD CONSTRAINT "TagMessage_workstreamPostId_WorkstreamPost_id_fk" FOREIGN KEY ("workstreamPostId") REFERENCES "public"."WorkstreamPost"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessage" ADD CONSTRAINT "TagMessage_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ADD CONSTRAINT "WorkstreamPost_teamId_Team_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ADD CONSTRAINT "WorkstreamPost_authorTagId_Tag_id_fk" FOREIGN KEY ("authorTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ADD CONSTRAINT "WorkstreamPost_sourceTaskId_Task_id_fk" FOREIGN KEY ("sourceTaskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "TagMessage_recipient_task_created_idx" ON "TagMessage" USING btree ("recipientTagId","taskId","createdAt");--> statement-breakpoint
CREATE INDEX "TagMessage_task_idx" ON "TagMessage" USING btree ("taskId");--> statement-breakpoint
CREATE INDEX "TagMessage_sender_history_idx" ON "TagMessage" USING btree ("senderTagId","createdAt","id");--> statement-breakpoint
CREATE INDEX "TagMessage_recipient_history_idx" ON "TagMessage" USING btree ("recipientTagId","createdAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "Team_name_key" ON "Team" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "WorkstreamPost_sequence_key" ON "WorkstreamPost" USING btree ("teamId","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "WorkstreamPost_idempotency_key" ON "WorkstreamPost" USING btree ("teamId","authorTagId","idempotencyKey");--> statement-breakpoint
ALTER TABLE "Objective" ADD CONSTRAINT "Objective_teamId_Team_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Objective_teamId_idx" ON "Objective" USING btree ("teamId");