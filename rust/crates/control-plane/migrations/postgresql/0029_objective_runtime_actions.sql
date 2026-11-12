ALTER TABLE supertag_v2_objectives ADD COLUMN runtime_actions TEXT NOT NULL DEFAULT '[]';
-- The previously accepted starting Task is the last durable evidence of the
-- original runtime authority. A later Tag edit cannot broaden this backfill.
UPDATE supertag_v2_objectives
SET runtime_actions = COALESCE(
    (SELECT allowed_actions FROM supertag_v2_tasks WHERE task_id=starting_task_id),
    '[]'
);
UPDATE supertag_v2_schema SET version=29 WHERE version=28;
