-- An operator or client has one conversation with each Tag, so a conversation has no name.
-- Its rows here are the conversation's Sessions; the next message continues the Session of its
-- latest message. Where a principal had several named conversations with a Tag, they become
-- Sessions of that one conversation, and its history shows all their messages in the order they
-- were accepted. Nothing is deleted, so every Task keeps its audience. The watch keeps its
-- conversation column, now always empty, rather than rewriting every watch trigger.
PRAGMA defer_foreign_keys = ON;

DROP VIEW supertag_v2_watch_tasks;
DROP VIEW supertag_v2_task_audience;

-- Recreated under its own name, so the messages that reference it find their rows again before
-- the deferred foreign keys are checked at commit.
CREATE TABLE supertag_v2_conversations_saved AS
SELECT session_id, principal, tag_id, created_order FROM supertag_v2_conversations;
DROP TABLE supertag_v2_conversations;
CREATE TABLE supertag_v2_conversations (
    session_id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    created_order BIGINT NOT NULL UNIQUE,
    UNIQUE (session_id, principal)
);
INSERT INTO supertag_v2_conversations (session_id, principal, tag_id, created_order)
SELECT session_id, principal, tag_id, created_order FROM supertag_v2_conversations_saved;
DROP TABLE supertag_v2_conversations_saved;
CREATE INDEX supertag_v2_conversation_owner_order
    ON supertag_v2_conversations (principal, created_order);
CREATE INDEX supertag_v2_conversation_owner_tag
    ON supertag_v2_conversations (principal, tag_id);

-- How far each principal has read its conversation with a Tag, as a conversation order.
CREATE TABLE supertag_v2_conversation_reads (
    principal TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    read_order BIGINT NOT NULL CHECK (read_order >= 0),
    read_at_ms BIGINT NOT NULL,
    PRIMARY KEY (principal, tag_id)
);

-- Marking a conversation read tells the principal's other clients.
CREATE TRIGGER supertag_v2_watch_conversation_read AFTER INSERT ON supertag_v2_conversation_reads
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 3, 2, NEW.tag_id, NEW.tag_id, '', '', '', '', NEW.principal;
END;
CREATE TRIGGER supertag_v2_watch_conversation_read_changed AFTER UPDATE ON supertag_v2_conversation_reads
WHEN NEW.read_order <> OLD.read_order
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 3, 2, NEW.tag_id, NEW.tag_id, '', '', '', '', NEW.principal;
END;

CREATE VIEW supertag_v2_task_audience AS
SELECT t.task_id, t.tag_id, t.session_id, COALESCE(o.objective_id, ws.objective_id, '') AS objective_id,
       '' AS conversation,
       COALESCE(c.principal, parent.principal,
                CASE WHEN substr(obj.created_by, 1, 7) = 'client:' THEN obj.created_by END, '') AS owner
FROM supertag_v2_tasks t
LEFT JOIN supertag_v2_conversation_messages m ON m.task_id = t.task_id
LEFT JOIN supertag_v2_conversations c ON c.session_id = t.session_id AND c.tag_id = t.tag_id
LEFT JOIN supertag_v2_work_session_tasks wt ON wt.task_id = t.task_id
LEFT JOIN supertag_v2_work_sessions ws ON ws.work_session_id = wt.work_session_id
LEFT JOIN supertag_v2_conversations parent ON parent.session_id = ws.parent_session_id
    AND parent.tag_id = ws.parent_tag_id
LEFT JOIN supertag_v2_objective_tasks o ON o.task_id = t.task_id
LEFT JOIN supertag_v2_objectives obj ON obj.objective_id = COALESCE(o.objective_id, ws.objective_id)
WHERE (substr(t.session_id, 1, 5) <> 'work/'
       OR (wt.kind = 1 AND ws.work_session_id = t.session_id AND ws.tag_id = t.tag_id
           AND (substr(ws.parent_session_id, 1, 13) <> 'conversation/' OR parent.session_id IS NOT NULL)))
  AND (substr(t.session_id, 1, 13) <> 'conversation/'
       OR (c.session_id IS NOT NULL AND (m.task_id IS NOT NULL
           OR (wt.kind = 2 AND ws.parent_session_id = t.session_id AND ws.parent_tag_id = t.tag_id))));
CREATE VIEW supertag_v2_watch_tasks AS
SELECT task_id, tag_id, session_id, objective_id, conversation, owner
FROM supertag_v2_task_audience;

UPDATE supertag_v2_schema SET version=83 WHERE version=82;
