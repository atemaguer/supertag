-- What each Task event shows (`TaskEventKind`): 1 a message the Tag wrote during its turn, 2 one
-- activity line, 3 `progress.updated` JSON. Earlier events were untyped text; progress JSON is
-- recognisable, and the rest were the Tag's messages or harness status lines.
ALTER TABLE supertag_v2_task_events ADD COLUMN kind INTEGER NOT NULL DEFAULT 1 CHECK (kind IN (1, 2, 3));
UPDATE supertag_v2_task_events SET kind=3 WHERE text LIKE '{"type":"progress.updated"%';
UPDATE supertag_v2_schema SET version=81 WHERE version=80;
