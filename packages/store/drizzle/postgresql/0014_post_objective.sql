-- Team channel posts record the Objective they were written under, and only readers of that
-- Objective see them. A stored post takes the Objective of the Task that wrote it, or else its
-- Team's governing Objective. Each Objective numbers its own posts in a channel, so stored posts
-- are renumbered 1, 2, … per Objective in their old order. Observation cursors, pending
-- observation batches and their unsettled notices, and registered wait_for afterSequence values
-- become the number of that Objective's posts at or before the old value, so no Objective skips
-- or repeats a post.
-- A reply that would cross Objectives loses its parent.
ALTER TABLE "WorkstreamPost" ADD COLUMN "objectiveId" text;--> statement-breakpoint
UPDATE "WorkstreamPost" SET "objectiveId" = coalesce(
	(SELECT "a"."objectiveId" FROM "TaskAssignment" "a" WHERE "a"."taskId" = "WorkstreamPost"."sourceTaskId"),
	(SELECT "t"."objectiveId" FROM "Team" "t" WHERE "t"."id" = "WorkstreamPost"."workstreamId")
);--> statement-breakpoint
UPDATE "WorkstreamPost" SET "replyTo" = NULL
WHERE "replyTo" IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM "WorkstreamPost" "parent"
	WHERE "parent"."id" = "WorkstreamPost"."replyTo"
	AND "parent"."workstreamId" = "WorkstreamPost"."workstreamId"
	AND "parent"."objectiveId" = "WorkstreamPost"."objectiveId"
);--> statement-breakpoint
UPDATE "Objective" "o" SET "observationState" = jsonb_set("o"."observationState", '{cursors}', coalesce((
	SELECT jsonb_object_agg("c"."key", (
		SELECT count(*) FROM "WorkstreamPost" "p"
		WHERE "p"."workstreamId" = "c"."key" AND "p"."objectiveId" = "o"."id" AND "p"."sequence" <= ("c"."value" #>> '{}')::bigint
	)) FROM jsonb_each("o"."observationState" -> 'cursors') "c"
), '{}'::jsonb))
WHERE jsonb_typeof("o"."observationState" -> 'cursors') = 'object';--> statement-breakpoint
UPDATE "Objective" "o" SET "observationState" = jsonb_set("o"."observationState", '{pending,through}', coalesce((
	SELECT jsonb_object_agg("c"."key", (
		SELECT count(*) FROM "WorkstreamPost" "p"
		WHERE "p"."workstreamId" = "c"."key" AND "p"."objectiveId" = "o"."id" AND "p"."sequence" <= ("c"."value" #>> '{}')::bigint
	)) FROM jsonb_each("o"."observationState" -> 'pending' -> 'through') "c"
), '{}'::jsonb))
WHERE jsonb_typeof("o"."observationState" -> 'pending' -> 'through') = 'object';--> statement-breakpoint
UPDATE "TaskAssignment" "a" SET "waitState" = jsonb_set("a"."waitState", '{workstreamPosts,afterSequence}', to_jsonb((
	SELECT count(*) FROM "WorkstreamPost" "p"
	WHERE "p"."workstreamId" = "a"."waitState" -> 'workstreamPosts' ->> 'workstreamId'
	AND "p"."objectiveId" = "a"."objectiveId"
	AND "p"."sequence" <= ("a"."waitState" -> 'workstreamPosts' ->> 'afterSequence')::bigint
)))
WHERE jsonb_typeof("a"."waitState" -> 'workstreamPosts') = 'object';--> statement-breakpoint
UPDATE "TagMessage" "m" SET "body" = "m"."body" || jsonb_build_object(
	'afterSequence', (
		SELECT count(*) FROM "WorkstreamPost" "p"
		WHERE "p"."workstreamId" = "m"."body" ->> 'workstreamId'
		AND "p"."objectiveId" = "m"."objectiveId"
		AND "p"."sequence" <= ("m"."body" ->> 'afterSequence')::bigint
	),
	'throughSequence', (
		SELECT count(*) FROM "WorkstreamPost" "p"
		WHERE "p"."workstreamId" = "m"."body" ->> 'workstreamId'
		AND "p"."objectiveId" = "m"."objectiveId"
		AND "p"."sequence" <= ("m"."body" ->> 'throughSequence')::bigint
	))
WHERE "m"."status" IN ('pending', 'processing') AND jsonb_typeof("m"."body") = 'object'
AND "m"."body" ->> 'kind' = 'observations.available';--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ALTER COLUMN "objectiveId" SET NOT NULL;--> statement-breakpoint
DROP INDEX "WorkstreamPost_sequence_key";--> statement-breakpoint
UPDATE "WorkstreamPost" "p" SET "sequence" = "r"."sequence"
FROM (
	SELECT "id", row_number() OVER (PARTITION BY "workstreamId", "objectiveId" ORDER BY "sequence") AS "sequence"
	FROM "WorkstreamPost"
) "r"
WHERE "r"."id" = "p"."id";--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ADD CONSTRAINT "WorkstreamPost_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "WorkstreamPost_sequence_key" ON "WorkstreamPost" USING btree ("workstreamId","objectiveId","sequence");
