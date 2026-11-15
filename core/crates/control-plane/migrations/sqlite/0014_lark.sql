CREATE TABLE supertag_v2_lark_accounts (
    account_id TEXT PRIMARY KEY,
    domain BIGINT NOT NULL,
    app_id TEXT NOT NULL,
    tenant_key TEXT NOT NULL
);
CREATE TABLE supertag_v2_lark_chats (
    account_id TEXT NOT NULL REFERENCES supertag_v2_lark_accounts(account_id),
    chat_id TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    PRIMARY KEY (account_id, chat_id)
);
CREATE TABLE supertag_v2_lark_threads (
    account_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    root_message_id TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    session_id TEXT NOT NULL,
    direct BIGINT NOT NULL CHECK (direct IN (0,1)),
    actor_id TEXT NOT NULL,
    PRIMARY KEY (account_id,chat_id,root_message_id)
);
CREATE TABLE supertag_v2_lark_messages (
    account_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (account_id,chat_id,message_id)
);
CREATE TABLE supertag_v2_lark_events (
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (account_id,event_id)
);
UPDATE supertag_v2_schema SET version = 14 WHERE version = 13;
