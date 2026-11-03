CREATE TABLE "OperatorInputReceipt" (
	"taskId" text NOT NULL,
	"attemptCount" integer NOT NULL,
	"messageId" text NOT NULL,
	"seenAt" text NOT NULL,
	"handledAt" text,
	"handlingKind" text,
	"handlingId" text,
	CONSTRAINT "OperatorInputReceipt_taskId_attemptCount_messageId_pk" PRIMARY KEY("taskId","attemptCount","messageId")
);
--> statement-breakpoint
ALTER TABLE "OperatorInputReceipt" ADD CONSTRAINT "OperatorInputReceipt_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OperatorInputReceipt" ADD CONSTRAINT "OperatorInputReceipt_messageId_TagMessage_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."TagMessage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "OperatorInputReceipt_message_idx" ON "OperatorInputReceipt" USING btree ("messageId");