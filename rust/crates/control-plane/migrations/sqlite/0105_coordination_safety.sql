-- How a surface message chose the Task's GitHub Workspace: request, origin or default.
-- `refused` marks a Task that failed at admission: it named a repository while its Tag may read
-- none, or its Session's selected Workspace is no longer usable. `required` asks the requester.
ALTER TABLE supertag_v2_tasks ADD COLUMN workspace_selection TEXT;
-- The latest changed-path report of each running Attempt that has an Objective and a Workspace.
CREATE TABLE supertag_v2_attempt_changed_paths (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    objective_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    paths TEXT NOT NULL,
    truncated BIGINT NOT NULL,
    reported_at_ms BIGINT NOT NULL
);
CREATE INDEX supertag_v2_attempt_changed_paths_scope
    ON supertag_v2_attempt_changed_paths (objective_id, workspace_id);
-- Each overlapping path of an Attempt pair is told to the Objective once.
CREATE TABLE supertag_v2_attempt_overlaps (
    objective_id TEXT NOT NULL,
    lower_attempt_id TEXT NOT NULL,
    higher_attempt_id TEXT NOT NULL,
    path TEXT NOT NULL,
    recorded_at_ms BIGINT NOT NULL,
    PRIMARY KEY (lower_attempt_id, higher_attempt_id, path)
);
-- Worker-managed effect receipts, scoped to the Tag that performs the effect.
CREATE TABLE supertag_v2_effect_receipts (
    tag_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    operation TEXT NOT NULL,
    state BIGINT NOT NULL,
    result_json TEXT,
    error TEXT,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    started_at_ms BIGINT NOT NULL,
    settled_at_ms BIGINT,
    PRIMARY KEY (tag_id, idempotency_key)
);
UPDATE supertag_v2_schema SET version=65 WHERE version=64;
