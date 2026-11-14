CREATE TABLE supertag_v2_linear_routes (
    account_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id)
);
CREATE TABLE supertag_v2_linear_sources (
    account_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    kind BIGINT NOT NULL,
    source_id TEXT NOT NULL,
    route_digest TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (account_id, workspace_id, kind, source_id)
);
CREATE TABLE supertag_v2_linear_deliveries (
    account_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (account_id, delivery_id)
);
UPDATE supertag_v2_schema SET version = 12 WHERE version = 11;
