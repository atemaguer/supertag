CREATE TABLE supertag_v2_conversations (
    session_id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    name TEXT NOT NULL,
    created_order BIGINT NOT NULL UNIQUE,
    UNIQUE (principal, tag_id, name),
    UNIQUE (session_id, principal)
);

CREATE TABLE supertag_v2_conversation_messages (
    task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    session_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    accepted_order BIGINT NOT NULL UNIQUE,
    UNIQUE (principal, operation_id),
    FOREIGN KEY (session_id, principal)
        REFERENCES supertag_v2_conversations(session_id, principal)
);

CREATE INDEX supertag_v2_conversation_owner_order
    ON supertag_v2_conversations (principal, created_order);
CREATE INDEX supertag_v2_conversation_message_order
    ON supertag_v2_conversation_messages (session_id, accepted_order);

UPDATE supertag_v2_schema SET version = 13 WHERE version = 12;
