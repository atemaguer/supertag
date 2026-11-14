-- Initial postgresql schema for the incompatible Rust runtime.
CREATE TABLE IF NOT EXISTS supertag_v2_schema (
    version BIGINT PRIMARY KEY CHECK (version = 1)
);
INSERT INTO supertag_v2_schema (version) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS supertag_v2_write_order (
    singleton BIGINT PRIMARY KEY CHECK (singleton = 1),
    revision BIGINT NOT NULL CHECK (revision >= 0)
);
INSERT INTO supertag_v2_write_order (singleton, revision) VALUES (1, 0) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS supertag_v2_tags (
    tag_id TEXT PRIMARY KEY,
    instructions TEXT NOT NULL,
    allowed_actions TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS supertag_v2_tasks (
    task_id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    session_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    instructions TEXT NOT NULL,
    allowed_actions TEXT NOT NULL,
    tag_revision BIGINT NOT NULL CHECK (tag_revision > 0),
    state BIGINT NOT NULL,
    result TEXT,
    attempt_id TEXT UNIQUE,
    host_principal TEXT,
    lease_token TEXT,
    accepted_order BIGINT NOT NULL UNIQUE,
    cleanup_pending BIGINT NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1)),
    next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence > 0)
);
CREATE INDEX IF NOT EXISTS supertag_v2_tasks_pending ON supertag_v2_tasks(state, accepted_order);

CREATE TABLE IF NOT EXISTS supertag_v2_admissions (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (principal, operation_id)
);

CREATE TABLE IF NOT EXISTS supertag_v2_claims (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    attempt_id TEXT,
    lease_token TEXT,
    PRIMARY KEY (principal, operation_id)
);

CREATE TABLE IF NOT EXISTS supertag_v2_task_events (
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    text TEXT NOT NULL,
    PRIMARY KEY (task_id, sequence)
);
