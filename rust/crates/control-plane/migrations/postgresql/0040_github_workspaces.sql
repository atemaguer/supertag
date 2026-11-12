CREATE TABLE supertag_v2_github_workspaces (
    workspace_id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL,
    payload BYTEA NOT NULL
);
ALTER TABLE supertag_v2_tasks ADD COLUMN workspace_github_source BYTEA NOT NULL DEFAULT ''::bytea;
ALTER TABLE supertag_v2_claims ADD COLUMN gateway_workspace_scope TEXT NOT NULL DEFAULT '[]';
UPDATE supertag_v2_schema SET version=40 WHERE version=39;
