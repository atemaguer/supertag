-- Persistent Objectives and their accepted work in the Rust schema.
CREATE TABLE supertag_v2_objectives (
    objective_id TEXT PRIMARY KEY,
    owner_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    session_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    ongoing BIGINT NOT NULL CHECK (ongoing IN (0, 1)),
    status BIGINT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    starting_task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    deadline_ms BIGINT,
    budget_limit_minor BIGINT CHECK (budget_limit_minor >= 0),
    budget_currency TEXT,
    paused_at_ms BIGINT,
    cancelled_at_ms BIGINT,
    cancellation_reason TEXT,
    completion_summary TEXT,
    idle_wake_count BIGINT NOT NULL DEFAULT 0 CHECK (idle_wake_count IN (0, 1)),
    limit_state TEXT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL
);
CREATE INDEX supertag_v2_objectives_owner ON supertag_v2_objectives(owner_tag_id, created_at_ms, objective_id);

CREATE TABLE supertag_v2_objective_sessions (
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    session_id TEXT NOT NULL,
    objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
    PRIMARY KEY (tag_id, session_id)
);
CREATE TABLE supertag_v2_objective_tasks (
    task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
    kind TEXT NOT NULL CHECK (kind IN ('work', 'notice', 'resume', 'idle'))
);
CREATE INDEX supertag_v2_objective_tasks_parent ON supertag_v2_objective_tasks(objective_id, task_id);

CREATE TABLE supertag_v2_objective_operations (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
    task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (principal, operation_id)
);
CREATE TABLE supertag_v2_objective_notices (
    objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
    notice_key TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (objective_id, notice_key)
);

CREATE TABLE supertag_v2_objective_usage (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
    sequence BIGINT NOT NULL DEFAULT 0,
    amount_minor BIGINT CHECK (amount_minor >= 0),
    currency TEXT,
    estimated BIGINT NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1))
);
CREATE TABLE supertag_v2_objective_usage_events (
    attempt_id TEXT NOT NULL REFERENCES supertag_v2_objective_usage(attempt_id),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    request_digest TEXT NOT NULL,
    PRIMARY KEY (attempt_id, sequence)
);

UPDATE supertag_v2_schema SET version = 4;
