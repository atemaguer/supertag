-- The conversation Task whose `create_objective` tool call made an Objective (TS
-- `Objective.surfaceTaskId`). Only the Control Plane's Tag tool path writes it; the Objective has
-- that conversation's audience, and one Task makes at most one Objective.
ALTER TABLE supertag_v2_objectives ADD COLUMN home_task_id TEXT REFERENCES supertag_v2_tasks(task_id);
CREATE UNIQUE INDEX supertag_v2_objectives_home_task ON supertag_v2_objectives(home_task_id);
UPDATE supertag_v2_schema SET version=80 WHERE version=79;
