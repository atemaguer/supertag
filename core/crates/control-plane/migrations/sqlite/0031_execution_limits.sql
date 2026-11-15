-- A Task records its accepted per-Attempt allowance. Empty means unconstrained.
ALTER TABLE supertag_v2_tasks ADD COLUMN execution_limits BLOB NOT NULL DEFAULT X'';
-- An approval decision cannot revive work after its budget or authority changed.
CREATE TABLE supertag_v2_approval_continuation_stops (
    task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    reason TEXT NOT NULL CHECK (reason IN ('budget','permissions')),
    notice_task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id)
);
UPDATE supertag_v2_schema SET version=31 WHERE version=30;
