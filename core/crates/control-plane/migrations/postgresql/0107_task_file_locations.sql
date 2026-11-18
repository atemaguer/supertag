-- A Worker Host's machine identifier (~/.supertag/machine-id), and where each running Attempt's
-- local checkout is on its host, so a client on the same machine can read a Task's files itself.
ALTER TABLE supertag_v2_host_readiness ADD COLUMN machine_id TEXT;

CREATE TABLE supertag_v2_task_file_locations (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    host_id TEXT NOT NULL,
    local_path TEXT NOT NULL,
    reported_at_ms BIGINT NOT NULL
);
CREATE INDEX supertag_v2_task_file_locations_task ON supertag_v2_task_file_locations (task_id);

UPDATE supertag_v2_schema SET version=107 WHERE version=106;
