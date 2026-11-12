-- PostgreSQL: durable surface admission and reply delivery in the Rust schema only.
CREATE TABLE supertag_v2_inbound_events (
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    conversation_id TEXT NOT NULL,
    thread_id TEXT,
    PRIMARY KEY (account_id, event_id)
);

CREATE TABLE supertag_v2_replies (
    reply_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    thread_id TEXT,
    text TEXT NOT NULL,
    state BIGINT NOT NULL,
    provider_receipt TEXT,
    lease_token TEXT,
    ready_order BIGINT NOT NULL UNIQUE
);
CREATE INDEX supertag_v2_replies_pending ON supertag_v2_replies(account_id, state, ready_order);

CREATE TABLE supertag_v2_reply_claims (
    account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    reply_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_replies(reply_id),
    lease_token TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_id)
);

-- The first schema's marker allowed only version 1. Replace just that marker;
-- domain records and history remain intact. The whole migration is transactional.
CREATE TABLE supertag_v2_schema_next (version BIGINT PRIMARY KEY CHECK (version > 0));
INSERT INTO supertag_v2_schema_next (version) VALUES (2);
DROP TABLE supertag_v2_schema;
ALTER TABLE supertag_v2_schema_next RENAME TO supertag_v2_schema;
