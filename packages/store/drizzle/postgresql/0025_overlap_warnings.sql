CREATE TABLE "AttemptChangedPaths" (
	"attemptId" text PRIMARY KEY NOT NULL,
	"paths" jsonb NOT NULL,
	"truncated" boolean NOT NULL,
	"reportedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OverlapWarning" (
	"teamId" text NOT NULL,
	"lowerAttemptId" text NOT NULL,
	"higherAttemptId" text NOT NULL,
	"path" text NOT NULL,
	CONSTRAINT "OverlapWarning_teamId_lowerAttemptId_higherAttemptId_path_pk" PRIMARY KEY("teamId","lowerAttemptId","higherAttemptId","path")
);
--> statement-breakpoint
ALTER TABLE "AttemptChangedPaths" ADD CONSTRAINT "AttemptChangedPaths_attemptId_TaskAttempt_id_fk" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskAttempt"("id") ON DELETE cascade ON UPDATE no action;