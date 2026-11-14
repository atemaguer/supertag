-- Organization Teams, shared Workstreams, and durable mutation receipts.
CREATE TABLE supertag_v2_teams (
    team_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    max_concurrency BIGINT CHECK (max_concurrency BETWEEN 1 AND 1000),
    revision BIGINT NOT NULL CHECK (revision > 0),
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    next_post_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_post_sequence > 0)
);

CREATE TABLE supertag_v2_team_members (
    team_id TEXT NOT NULL REFERENCES supertag_v2_teams(team_id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    PRIMARY KEY (team_id, tag_id)
);
CREATE INDEX supertag_v2_team_members_tag ON supertag_v2_team_members(tag_id, team_id);

CREATE TABLE supertag_v2_team_operations (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    team_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    revision BIGINT NOT NULL CHECK (revision > 0),
    mutation_order BIGINT NOT NULL UNIQUE,
    response BYTEA NOT NULL,
    PRIMARY KEY (principal, operation_id)
);
CREATE INDEX supertag_v2_team_operations_history ON supertag_v2_team_operations(team_id, revision);

CREATE TABLE supertag_v2_workstream_posts (
    post_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES supertag_v2_teams(team_id) ON DELETE CASCADE,
    author_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    source_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    to_tag_ids TEXT NOT NULL,
    body TEXT NOT NULL,
    effect_digest TEXT NOT NULL,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    created_at_ms BIGINT NOT NULL,
    UNIQUE (team_id, sequence),
    UNIQUE (team_id, source_task_id, effect_digest)
);

CREATE TABLE supertag_v2_workstream_operations (
    source_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    post_id TEXT NOT NULL REFERENCES supertag_v2_workstream_posts(post_id) ON DELETE CASCADE,
    PRIMARY KEY (source_task_id, operation_id)
);

ALTER TABLE supertag_v2_objectives ADD COLUMN team_id TEXT
    REFERENCES supertag_v2_teams(team_id) ON DELETE SET NULL;
CREATE INDEX supertag_v2_objectives_team ON supertag_v2_objectives(team_id, status);

UPDATE supertag_v2_schema SET version = 15 WHERE version = 14;
