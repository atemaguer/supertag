-- PostgreSQL: execution deadlines and recorded decisions for uncertain attempts.
ALTER TABLE supertag_v2_tasks ADD COLUMN lease_expires_at_ms BIGINT;
ALTER TABLE supertag_v2_tasks ADD COLUMN cleanup_observed BIGINT NOT NULL DEFAULT 0 CHECK (cleanup_observed IN (0, 1));
ALTER TABLE supertag_v2_tasks ADD COLUMN event_sequence_base BIGINT NOT NULL DEFAULT 0 CHECK (event_sequence_base >= 0);
ALTER TABLE supertag_v2_tasks ADD COLUMN finish_objective_signal BIGINT NOT NULL DEFAULT 0;

CREATE INDEX supertag_v2_tasks_lease_expiry ON supertag_v2_tasks(state, lease_expires_at_ms);
CREATE UNIQUE INDEX supertag_v2_claims_attempt ON supertag_v2_claims(attempt_id);

CREATE TABLE supertag_v2_attempt_resolutions (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    operator_principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    decision BIGINT NOT NULL CHECK (decision IN (1, 2)),
    evidence TEXT NOT NULL,
    confirmed_stopped BIGINT NOT NULL CHECK (confirmed_stopped IN (0, 1)),
    resolved_at_ms BIGINT NOT NULL,
    UNIQUE (operator_principal, operation_id)
);

-- Old claims never authorized native execution, so they can be safely requeued.
UPDATE supertag_v2_tasks SET state = 1, attempt_id = NULL, host_principal = NULL, lease_token = NULL
WHERE state = 6;
-- In-flight execution from the previous schema has no timed authority. Preserve
-- ownership until cleanup is observed and an operator resolves the uncertainty.
UPDATE supertag_v2_tasks SET state = 7, cleanup_pending = 1, lease_expires_at_ms = 0
WHERE state = 2;
UPDATE supertag_v2_tasks SET lease_expires_at_ms = 0 WHERE state = 5 AND cleanup_pending = 1;

UPDATE supertag_v2_schema SET version = 3 WHERE version = 2;
