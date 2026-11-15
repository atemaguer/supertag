CREATE TABLE supertag_v2_github_source_pins (
    pin_id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    selector BYTEA NOT NULL,
    selector_digest TEXT NOT NULL,
    resolved BYTEA,
    created_order BIGINT NOT NULL UNIQUE,
    UNIQUE(tag_id, session_id)
);
CREATE INDEX supertag_v2_github_source_pending ON supertag_v2_github_source_pins(account_id, created_order);
UPDATE supertag_v2_schema SET version=44 WHERE version=43;
