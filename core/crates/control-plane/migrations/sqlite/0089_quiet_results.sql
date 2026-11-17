-- A turn no person waited on may finish quietly: it posts nothing and its conversation hides it.
ALTER TABLE supertag_v2_tasks ADD COLUMN quiet SMALLINT NOT NULL DEFAULT 0 CHECK (quiet IN (0, 1));

-- A Tag's unprompted turns that had someone to reach: each posted reply (and whether a person
-- read or answered it) or quiet check. `conversation_order` is the turn's order in a
-- conversation, NULL for a surface reply.
CREATE TABLE supertag_v2_proactive_posts (
    task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    conversation_order BIGINT,
    posted_at_ms BIGINT NOT NULL,
    quiet SMALLINT NOT NULL CHECK (quiet IN (0, 1)),
    read_at_ms BIGINT,
    answered_at_ms BIGINT
);
CREATE INDEX supertag_v2_proactive_posts_tag ON supertag_v2_proactive_posts (tag_id, posted_at_ms);
CREATE INDEX supertag_v2_proactive_posts_session ON supertag_v2_proactive_posts (session_id, posted_at_ms);

-- The Gateway no longer notifies on its own machine; the desktop app notifies on its device.
DELETE FROM supertag_v2_operator_notification_items WHERE notification_id IN
    (SELECT notification_id FROM supertag_v2_operator_notifications WHERE provider=3);
DELETE FROM supertag_v2_operator_notifications WHERE provider=3;

UPDATE supertag_v2_schema SET version=89 WHERE version=88;
