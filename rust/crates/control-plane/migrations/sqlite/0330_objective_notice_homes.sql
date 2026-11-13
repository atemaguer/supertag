-- An operator-chosen surface Task whose thread gets an Objective's notices.
ALTER TABLE supertag_v2_objectives ADD COLUMN notification_task_id TEXT REFERENCES supertag_v2_tasks(task_id);
-- The home a notice was addressed to ('thread' or 'task:ID'), and for a limit notice its
-- limit event, so a queued notice whose limit, home, or Objective changed is withdrawn.
ALTER TABLE supertag_v2_objective_notices ADD COLUMN home TEXT;
ALTER TABLE supertag_v2_objective_notices ADD COLUMN limit_key TEXT;
-- Reports are now keyed by home too. Every earlier report went to the start thread, so it keeps
-- its key there and is not posted again.
UPDATE supertag_v2_objective_notices SET notice_key=notice_key || '@thread', home='thread' WHERE notice_key LIKE 'report:%';
-- The deployment's default notice thread, from SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID.
CREATE TABLE supertag_v2_notification_defaults (
    singleton BIGINT PRIMARY KEY CHECK (singleton = 1),
    task_id TEXT NOT NULL
);
UPDATE supertag_v2_schema SET version=69 WHERE version=68;
