-- The Attempt credential StartTask returns for a Task's current Attempt, as its SHA-256 in hex.
-- It names the Attempt, its lease, and the Worker Host generation holding it, and resolves only
-- while that Task still records the same Attempt, lease, and host generation with a live lease.
-- One per Task: starting an Attempt again replaces it.
CREATE TABLE supertag_v2_attempt_credentials (
    task_id TEXT PRIMARY KEY NOT NULL,
    attempt_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    host_id TEXT NOT NULL,
    host_generation BIGINT NOT NULL,
    token_digest TEXT NOT NULL UNIQUE,
    issued_at_ms BIGINT NOT NULL
);

UPDATE supertag_v2_schema SET version=115 WHERE version=114;
