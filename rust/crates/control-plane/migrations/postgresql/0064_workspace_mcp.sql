ALTER TABLE supertag_v2_tags ADD COLUMN workspace_mcp_servers TEXT;
ALTER TABLE supertag_v2_tasks ADD COLUMN workspace_mcp_servers TEXT;
CREATE TABLE supertag_v2_workspace_mcp_attempts (
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    record BYTEA NOT NULL,
    PRIMARY KEY (task_id, attempt_id)
);
CREATE TABLE supertag_v2_mcp_login_lapses (
    host_id TEXT NOT NULL,
    server TEXT NOT NULL,
    observed_at_ms BIGINT NOT NULL,
    PRIMARY KEY (host_id, server)
);
UPDATE supertag_v2_schema SET version=64 WHERE version=63;
