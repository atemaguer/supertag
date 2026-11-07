ALTER TABLE "Session" ADD COLUMN "parentSessionId" text;--> statement-breakpoint
ALTER TABLE "Session" ADD CONSTRAINT "Session_parentSessionId_Session_id_fk" FOREIGN KEY ("parentSessionId") REFERENCES "public"."Session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Session_parentSessionId_idx" ON "Session" USING btree ("parentSessionId");