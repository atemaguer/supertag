ALTER TABLE supertag_v2_workspace_volumes ADD COLUMN credential TEXT NOT NULL DEFAULT '';
CREATE TABLE supertag_v2_workspace_mount_writes (
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    recorded_order BIGINT NOT NULL,
    writes BYTEA NOT NULL,
    PRIMARY KEY (task_id, attempt_id)
);
UPDATE supertag_v2_schema SET version=75 WHERE version=74;
