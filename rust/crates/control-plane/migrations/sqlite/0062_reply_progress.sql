-- A Slack-style reply updated in place while its Task runs: the acknowledgement, then
-- rate-limited progress, replaced by the final reply. Only the newest revision is kept.
CREATE TABLE supertag_v2_reply_progress (
    task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    text TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    sent_revision BIGINT NOT NULL DEFAULT 0,
    provider_receipt TEXT,
    stopped BIGINT NOT NULL DEFAULT 0 CHECK (stopped IN (0,1)),
    lease_token TEXT,
    lease_revision BIGINT,
    lease_expires_at_ms BIGINT,
    next_at_ms BIGINT NOT NULL DEFAULT 0,
    ready_order BIGINT NOT NULL UNIQUE
);
CREATE INDEX supertag_v2_reply_progress_ready ON supertag_v2_reply_progress(account_id, stopped, ready_order);
CREATE TABLE supertag_v2_reply_progress_claims (
    account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES supertag_v2_reply_progress(task_id),
    response BLOB NOT NULL,
    PRIMARY KEY (account_id, operation_id)
);
UPDATE supertag_v2_schema SET version=62 WHERE version=56;
