CREATE TABLE supertag_v2_artifact_captures (
    artifact_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    attempt_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    payload BYTEA NOT NULL,
    committed_order BIGINT UNIQUE,
    UNIQUE (attempt_id, operation_id)
);
CREATE INDEX supertag_v2_artifact_captures_task ON supertag_v2_artifact_captures(task_id, committed_order DESC)
    WHERE committed_order IS NOT NULL;
UPDATE supertag_v2_schema SET version=41 WHERE version=40;
