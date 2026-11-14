ALTER TABLE supertag_v2_tags ADD COLUMN workspace_id TEXT;
ALTER TABLE supertag_v2_tags ADD COLUMN workspace_base_commit TEXT;
ALTER TABLE supertag_v2_tasks ADD COLUMN workspace_id TEXT;
ALTER TABLE supertag_v2_tasks ADD COLUMN workspace_base_commit TEXT;
ALTER TABLE supertag_v2_tasks ADD COLUMN workspace_delivery BLOB;
ALTER TABLE supertag_v2_claims ADD COLUMN workspace_scope TEXT;

CREATE INDEX supertag_v2_tasks_session_order
    ON supertag_v2_tasks (tag_id, session_id, accepted_order);

CREATE TABLE supertag_v2_workspace_deliveries (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    reference BLOB NOT NULL,
    committed_at_ms BIGINT
);

CREATE TABLE supertag_v2_workspace_heads (
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES supertag_v2_workspace_deliveries(attempt_id),
    PRIMARY KEY (tag_id, session_id)
);

UPDATE supertag_v2_schema SET version = 7 WHERE version = 6;
