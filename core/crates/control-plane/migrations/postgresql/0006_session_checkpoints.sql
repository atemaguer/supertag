CREATE TABLE supertag_v2_checkpoints (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    harness TEXT NOT NULL,
    format TEXT NOT NULL,
    byte_length BIGINT NOT NULL CHECK (byte_length > 0),
    sha256 TEXT NOT NULL,
    committed BIGINT NOT NULL DEFAULT 0 CHECK (committed IN (0, 1))
);

CREATE TABLE supertag_v2_session_checkpoints (
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES supertag_v2_checkpoints(attempt_id),
    PRIMARY KEY (tag_id, session_id)
);

ALTER TABLE supertag_v2_tasks ADD COLUMN finish_checkpoint_sha256 TEXT;

CREATE TABLE supertag_v2_native_usage (
    attempt_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
    cached_input_tokens BIGINT NOT NULL CHECK (cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens),
    output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
    observed_model TEXT,
    PRIMARY KEY (attempt_id, sequence)
);

UPDATE supertag_v2_schema SET version = 6 WHERE version = 5;
