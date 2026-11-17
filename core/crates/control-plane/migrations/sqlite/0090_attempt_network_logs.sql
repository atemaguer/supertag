-- Each Attempt's egress proxy log, reported by its Worker Host. A later report replaces it.
CREATE TABLE supertag_v2_attempt_network_logs (
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    recorded_order BIGINT NOT NULL,
    log BLOB NOT NULL,
    PRIMARY KEY (task_id, attempt_id)
);

UPDATE supertag_v2_schema SET version=90 WHERE version=89;
