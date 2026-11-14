-- Keep direct delivery private from the Team's shared Workstream. The two
-- origins have explicit, mutually exclusive provenance and share inbox batching.
CREATE TABLE supertag_v2_mailbox_messages_new (
    message_id TEXT PRIMARY KEY,
    sender_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    recipient_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    source_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    origin BIGINT NOT NULL CHECK (origin IN (1, 2)),
    workstream_post_id TEXT,
    objective_id TEXT,
    text TEXT NOT NULL,
    hops BIGINT NOT NULL CHECK (hops BETWEEN 0 AND 4),
    task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    created_at_ms BIGINT NOT NULL,
    delivery_order BIGINT NOT NULL UNIQUE,
    UNIQUE (workstream_post_id, recipient_tag_id),
    CHECK (sender_tag_id <> recipient_tag_id),
    CHECK ((origin = 1 AND workstream_post_id IS NULL) OR
           (origin = 2 AND workstream_post_id IS NOT NULL))
);
INSERT INTO supertag_v2_mailbox_messages_new
    (message_id,sender_tag_id,recipient_tag_id,source_task_id,origin,workstream_post_id,objective_id,text,hops,task_id,created_at_ms,delivery_order)
SELECT message_id,sender_tag_id,recipient_tag_id,source_task_id,2,workstream_post_id,objective_id,text,hops,task_id,created_at_ms,delivery_order
FROM supertag_v2_mailbox_messages;
DROP TABLE supertag_v2_mailbox_messages;
ALTER TABLE supertag_v2_mailbox_messages_new RENAME TO supertag_v2_mailbox_messages;
CREATE INDEX supertag_v2_mailbox_pending ON supertag_v2_mailbox_messages(recipient_tag_id, task_id, delivery_order);
CREATE INDEX supertag_v2_mailbox_sent ON supertag_v2_mailbox_messages(sender_tag_id, delivery_order);
CREATE INDEX supertag_v2_mailbox_task ON supertag_v2_mailbox_messages(task_id);
CREATE INDEX supertag_v2_mailbox_direct_sends ON supertag_v2_mailbox_messages(source_task_id, origin);

CREATE TABLE supertag_v2_mailbox_grants (
    sender_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    recipient_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    granted_by TEXT NOT NULL,
    granted_at_ms BIGINT NOT NULL,
    PRIMARY KEY (sender_tag_id, recipient_tag_id),
    CHECK (sender_tag_id <> recipient_tag_id)
);
CREATE INDEX supertag_v2_mailbox_grants_recipient ON supertag_v2_mailbox_grants(recipient_tag_id, sender_tag_id);
CREATE TABLE supertag_v2_mailbox_grant_operations (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    changed BIGINT NOT NULL CHECK (changed IN (0, 1)),
    PRIMARY KEY (principal, operation_id)
);
CREATE TABLE supertag_v2_mailbox_send_operations (
    source_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES supertag_v2_mailbox_messages(message_id),
    PRIMARY KEY (source_task_id, operation_id)
);
UPDATE supertag_v2_schema SET version = 24 WHERE version = 23;
