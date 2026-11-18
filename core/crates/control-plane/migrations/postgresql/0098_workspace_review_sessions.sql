-- The pull request each Session's review landing opened, so a merged pull request closes the
-- Work Session that opened it.
CREATE TABLE supertag_v2_workspace_review_sessions (
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    repository TEXT NOT NULL,
    repository_id BIGINT NOT NULL,
    number BIGINT NOT NULL,
    PRIMARY KEY(tag_id, session_id)
);
CREATE INDEX supertag_v2_workspace_review_sessions_pull ON supertag_v2_workspace_review_sessions(repository_id, number);
UPDATE supertag_v2_schema SET version=98 WHERE version=97;
