CREATE TABLE supertag_v2_github_repositories (
    account_id TEXT NOT NULL,
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    repository TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    PRIMARY KEY (account_id, repository_id)
);
CREATE TABLE supertag_v2_github_sources (
    account_id TEXT NOT NULL,
    repository_id BIGINT NOT NULL,
    kind BIGINT NOT NULL,
    source_id BIGINT NOT NULL CHECK (source_id > 0),
    route_digest TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (account_id, repository_id, kind, source_id)
);
CREATE TABLE supertag_v2_github_deliveries (
    account_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (account_id, delivery_id)
);
UPDATE supertag_v2_schema SET version = 10 WHERE version = 9;
