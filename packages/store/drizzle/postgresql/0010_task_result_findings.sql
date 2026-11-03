-- Task results now always carry a findings list. Give results stored before findings, or with
-- findings that are not a list, an empty list.
UPDATE "Task" SET "result" = jsonb_set("result", '{findings}', '[]'::jsonb)
WHERE jsonb_typeof("result") = 'object' AND jsonb_typeof("result"->'findings') IS DISTINCT FROM 'array';--> statement-breakpoint
UPDATE "TaskAssignment" SET "result" = jsonb_set("result", '{taskResult,findings}', '[]'::jsonb)
WHERE jsonb_typeof("result"->'taskResult') = 'object' AND jsonb_typeof("result"->'taskResult'->'findings') IS DISTINCT FROM 'array';--> statement-breakpoint
UPDATE "Task" SET "sessionHistory" = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(e.value->'result') = 'object' AND jsonb_typeof(e.value->'result'->'findings') IS DISTINCT FROM 'array'
        THEN jsonb_set(e.value, '{result,findings}', '[]'::jsonb)
      ELSE e.value
    END
    ORDER BY e.ordinality
  )
  FROM jsonb_array_elements("Task"."sessionHistory") WITH ORDINALITY AS e(value, ordinality)
)
WHERE jsonb_typeof("sessionHistory") = 'array' AND jsonb_array_length("sessionHistory") > 0;
