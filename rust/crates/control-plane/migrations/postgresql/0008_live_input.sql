CREATE TABLE supertag_v2_live_inputs (
    input_id TEXT PRIMARY KEY,
    operator_principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    attempt_id TEXT NOT NULL,
    follower_task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    state BIGINT NOT NULL CHECK (state BETWEEN 1 AND 8),
    acknowledgement_deadline_ms BIGINT,
    UNIQUE (operator_principal, operation_id)
);

CREATE INDEX supertag_v2_live_inputs_state ON supertag_v2_live_inputs(state, acknowledgement_deadline_ms);
CREATE INDEX supertag_v2_tasks_session_queue ON supertag_v2_tasks(tag_id, session_id, state, accepted_order);

CREATE TABLE supertag_v2_live_input_resolutions (
    input_id TEXT PRIMARY KEY REFERENCES supertag_v2_live_inputs(input_id),
    operator_principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    decision BIGINT NOT NULL CHECK (decision IN (1, 2)),
    evidence TEXT NOT NULL,
    resolved_at_ms BIGINT NOT NULL,
    UNIQUE (operator_principal, operation_id)
);

UPDATE supertag_v2_schema SET version = 8 WHERE version = 7;
