CREATE TABLE supertag_v2_artifact_acquisitions (
    acquisition_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    attempt_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL REFERENCES supertag_v2_artifact_captures(artifact_id),
    request_digest TEXT NOT NULL,
    state BIGINT NOT NULL CHECK(state BETWEEN 1 AND 4),
    payload BLOB NOT NULL,
    created_order BIGINT NOT NULL UNIQUE,
    UNIQUE(attempt_id, operation_id)
);
CREATE INDEX supertag_v2_artifact_acquisition_inputs ON supertag_v2_artifact_acquisitions(attempt_id,state,created_order);
UPDATE supertag_v2_schema SET version=46 WHERE version=45;
