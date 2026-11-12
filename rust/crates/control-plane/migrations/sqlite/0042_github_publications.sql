CREATE TABLE supertag_v2_github_publications (
    publication_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    created_order BIGINT NOT NULL UNIQUE,
    state BIGINT NOT NULL CHECK (state BETWEEN 1 AND 8),
    phase BIGINT NOT NULL DEFAULT 0 CHECK (phase BETWEEN 0 AND 3),
    payload BLOB NOT NULL,
    approval_id TEXT UNIQUE REFERENCES supertag_v2_approvals(approval_id),
    publisher TEXT,
    lease_token TEXT,
    lease_expires_at_ms BIGINT,
    recovery_only BIGINT NOT NULL DEFAULT 0 CHECK (recovery_only IN (0,1)),
    retry_after_ms BIGINT NOT NULL DEFAULT 0,
    planned BIGINT NOT NULL DEFAULT 0 CHECK (planned IN (0,1)),
    pushed BIGINT NOT NULL DEFAULT 0 CHECK (pushed IN (0,1)),
    cancel_requested BIGINT NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1))
);
CREATE INDEX supertag_v2_github_publications_queue ON supertag_v2_github_publications(account_id,state,created_order);
CREATE INDEX supertag_v2_github_publications_session ON supertag_v2_github_publications(tag_id,session_id,created_order);
CREATE TABLE supertag_v2_github_publication_claims (
    publisher TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    publication_id TEXT NOT NULL REFERENCES supertag_v2_github_publications(publication_id),
    response BLOB NOT NULL,
    PRIMARY KEY(publisher,operation_id)
);
CREATE TABLE supertag_v2_github_publication_operations (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    publication_id TEXT NOT NULL REFERENCES supertag_v2_github_publications(publication_id),
    response BLOB NOT NULL,
    PRIMARY KEY(principal,operation_id)
);
CREATE TABLE supertag_v2_github_publication_sessions (
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    publication_id TEXT NOT NULL REFERENCES supertag_v2_github_publications(publication_id),
    pull_request BLOB NOT NULL,
    PRIMARY KEY(tag_id,session_id)
);
CREATE TABLE supertag_v2_github_publication_sweep (singleton BIGINT PRIMARY KEY CHECK(singleton=1), last_order BIGINT NOT NULL DEFAULT 0);
INSERT INTO supertag_v2_github_publication_sweep(singleton,last_order) VALUES(1,0);
UPDATE supertag_v2_schema SET version=42 WHERE version=41;
