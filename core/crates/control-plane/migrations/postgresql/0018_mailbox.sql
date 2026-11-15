-- Addressed Workstream delivery survives Team deletion and records its provenance.
CREATE TABLE supertag_v2_mailbox_messages (
    message_id TEXT PRIMARY KEY,
    sender_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    recipient_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    source_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    workstream_post_id TEXT NOT NULL,
    objective_id TEXT,
    text TEXT NOT NULL,
    hops BIGINT NOT NULL CHECK (hops BETWEEN 0 AND 4),
    task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    created_at_ms BIGINT NOT NULL,
    delivery_order BIGINT NOT NULL UNIQUE,
    UNIQUE (workstream_post_id, recipient_tag_id),
    CHECK (sender_tag_id <> recipient_tag_id)
);
CREATE INDEX supertag_v2_mailbox_pending ON supertag_v2_mailbox_messages(recipient_tag_id, task_id, delivery_order);
CREATE INDEX supertag_v2_mailbox_sent ON supertag_v2_mailbox_messages(sender_tag_id, delivery_order);
CREATE INDEX supertag_v2_mailbox_task ON supertag_v2_mailbox_messages(task_id);
CREATE TABLE supertag_v2_mailbox_tasks (
    task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    recipient_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    bound BIGINT NOT NULL DEFAULT 0 CHECK (bound IN (0, 1))
);
CREATE INDEX supertag_v2_mailbox_recipient_tasks ON supertag_v2_mailbox_tasks(recipient_tag_id);
UPDATE supertag_v2_schema SET version = 18 WHERE version = 17;
