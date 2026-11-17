-- Remote Workspaces on any git server replace GitHub Workspaces, and git delivery's landings
-- replace GitHub pull request publications. Pre-release: nothing is carried over.
DROP TABLE supertag_v2_github_publication_claims;
DROP TABLE supertag_v2_github_publication_operations;
DROP TABLE supertag_v2_github_publication_sessions;
DROP TABLE supertag_v2_github_publication_sweep;
DROP TABLE supertag_v2_github_publications;
DROP TABLE supertag_v2_github_source_pins;
DROP TABLE supertag_v2_github_workspaces;
ALTER TABLE supertag_v2_tasks RENAME COLUMN workspace_github_source TO workspace_remote;
UPDATE supertag_v2_tasks SET workspace_remote=X'';
ALTER TABLE supertag_v2_tasks DROP COLUMN workspace_selection;
-- A merge follow-up Task's target commit, which its Worker Host merges into the checkout.
ALTER TABLE supertag_v2_tasks ADD COLUMN workspace_merge_commit TEXT NOT NULL DEFAULT '';
CREATE TABLE supertag_v2_workspaces (
    workspace_id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL,
    payload BLOB NOT NULL
);
CREATE TABLE supertag_v2_workspace_credentials (
    name TEXT PRIMARY KEY,
    revision BIGINT NOT NULL,
    payload BLOB NOT NULL
);
CREATE TABLE supertag_v2_workspace_source_pins (
    pin_id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    selector BLOB NOT NULL,
    selector_digest TEXT NOT NULL,
    resolved BLOB,
    created_order BIGINT NOT NULL UNIQUE,
    UNIQUE(tag_id, session_id)
);
CREATE TABLE supertag_v2_workspace_landings (
    landing_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_order BIGINT NOT NULL UNIQUE,
    state BIGINT NOT NULL CHECK (state BETWEEN 1 AND 6),
    payload BLOB NOT NULL,
    lease_token TEXT,
    lease_expires_at_ms BIGINT,
    retry_after_ms BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX supertag_v2_workspace_landings_queue ON supertag_v2_workspace_landings(state,created_order);
CREATE INDEX supertag_v2_workspace_landings_session ON supertag_v2_workspace_landings(tag_id,session_id,created_order);
CREATE TABLE supertag_v2_workspace_landing_operations (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response BLOB NOT NULL,
    PRIMARY KEY(principal,operation_id)
);
UPDATE supertag_v2_schema SET version=97 WHERE version=96;
