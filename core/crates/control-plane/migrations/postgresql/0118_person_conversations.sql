-- A person's conversation with a Tag moves onto the one message model (messaging phase 2). Each
-- principal and Tag get one direct conversation; every turn the conversation showed, across all of
-- its Sessions, becomes one of its messages, numbered in the order it was shown. A turn's message
-- has no text: its content is its Task. The person sends their messages, approval continuations,
-- and budget stops; the Tag sends Schedule fires and Work Session reports. The person's read mark
-- becomes their member row's read_seq. The conversation gets a new ID, so every client discards
-- its copy and reads the conversation again in the new order.
ALTER TABLE supertag_v2_proactive_posts RENAME COLUMN conversation_order TO conversation_seq;

DROP VIEW supertag_v2_watch_tasks;
DROP VIEW supertag_v2_task_audience;
DROP VIEW supertag_v2_conversation_history;

-- 1. One direct conversation per principal and Tag.
INSERT INTO supertag_v2_conversations (conversation_id, kind, direct_key, next_seq, created_at_ms)
SELECT 'direct/' || md5(random()::text || clock_timestamp()::text || s.principal || s.tag_id), 1,
       'p:' || s.principal || chr(10) || 't:' || s.tag_id, 1, 0
FROM (SELECT DISTINCT principal, tag_id FROM supertag_v2_conversation_sessions) s;

-- 2. What each conversation showed: its messages and the report turns in its Sessions.
CREATE TEMPORARY TABLE supertag_v2_m118_history AS
SELECT m.task_id, m.session_id, m.accepted_order, 0 AS report, m.operation_id, m.request_digest
FROM supertag_v2_conversation_messages m
UNION ALL
SELECT t.task_id, t.session_id, t.accepted_order, 1, NULL, NULL
FROM supertag_v2_work_session_tasks wt
JOIN supertag_v2_work_sessions ws ON ws.work_session_id = wt.work_session_id
JOIN supertag_v2_tasks t ON t.task_id = wt.task_id AND t.session_id = ws.parent_session_id
    AND t.tag_id = ws.parent_tag_id
WHERE wt.kind = 2
  AND NOT EXISTS (SELECT 1 FROM supertag_v2_conversation_messages m WHERE m.task_id = t.task_id);
CREATE TEMPORARY TABLE supertag_v2_m118_turns AS
SELECT c.conversation_id, h.task_id, h.accepted_order, h.report, h.operation_id, h.request_digest,
       s.principal, s.tag_id, t.accepted_at_ms,
       CASE WHEN h.report = 1
              OR EXISTS (SELECT 1 FROM supertag_v2_schedule_fires f WHERE f.task_id = h.task_id)
            THEN 1 ELSE 2 END AS sender_kind,
       ROW_NUMBER() OVER (PARTITION BY c.conversation_id ORDER BY h.accepted_order, h.task_id) AS seq
FROM supertag_v2_m118_history h
JOIN supertag_v2_conversation_sessions s ON s.session_id = h.session_id
JOIN supertag_v2_tasks t ON t.task_id = h.task_id AND t.tag_id = s.tag_id
JOIN supertag_v2_conversations c ON c.direct_key = 'p:' || s.principal || chr(10) || 't:' || s.tag_id;

-- 3. Each turn becomes a message.
INSERT INTO supertag_v2_messages
    (conversation_id, seq, message_id, sender_kind, sender_id, kind, text, task_id, created_at_ms)
SELECT conversation_id, seq, md5(random()::text || clock_timestamp()::text || task_id), sender_kind,
       CASE WHEN sender_kind = 1 THEN tag_id ELSE principal END, 1, '', task_id,
       COALESCE(accepted_at_ms, 0)
FROM supertag_v2_m118_turns;
UPDATE supertag_v2_conversations
SET next_seq = 1 + (SELECT COUNT(*) FROM supertag_v2_m118_turns t
                    WHERE t.conversation_id = supertag_v2_conversations.conversation_id),
    created_at_ms = COALESCE((SELECT MIN(t.accepted_at_ms) FROM supertag_v2_m118_turns t
                              WHERE t.conversation_id = supertag_v2_conversations.conversation_id), 0)
WHERE kind = 1 AND substr(direct_key, 1, 2) = 'p:';

-- 4. The principal's operation receipts, so a replayed send returns its message.
INSERT INTO supertag_v2_message_operations (scope, scope_id, operation_id, request_digest, message_id)
SELECT 3, t.principal, t.operation_id, t.request_digest, m.message_id
FROM supertag_v2_m118_turns t
JOIN supertag_v2_messages m ON m.task_id = t.task_id
WHERE t.report = 0;

-- 5. Members: the person keeps how far they read; the Tag has seen every turn.
INSERT INTO supertag_v2_conversation_members
    (conversation_id, member_kind, member_id, read_seq, delivered_seq, joined_at_ms, read_at_ms)
SELECT c.conversation_id, 2, p.principal,
       COALESCE((SELECT MAX(t.seq) FROM supertag_v2_m118_turns t
                 WHERE t.conversation_id = c.conversation_id AND t.accepted_order <= r.read_order), 0),
       0, c.created_at_ms, r.read_at_ms
FROM (SELECT DISTINCT principal, tag_id FROM supertag_v2_conversation_sessions) p
JOIN supertag_v2_conversations c ON c.direct_key = 'p:' || p.principal || chr(10) || 't:' || p.tag_id
LEFT JOIN supertag_v2_conversation_reads r ON r.principal = p.principal AND r.tag_id = p.tag_id;
INSERT INTO supertag_v2_conversation_members
    (conversation_id, member_kind, member_id, read_seq, delivered_seq, joined_at_ms)
SELECT c.conversation_id, 1, p.tag_id, c.next_seq - 1, c.next_seq - 1, c.created_at_ms
FROM (SELECT DISTINCT principal, tag_id FROM supertag_v2_conversation_sessions) p
JOIN supertag_v2_conversations c ON c.direct_key = 'p:' || p.principal || chr(10) || 't:' || p.tag_id;

-- 6. An unprompted post's place in its conversation is its message's seq.
UPDATE supertag_v2_proactive_posts
SET conversation_seq = (SELECT m.seq FROM supertag_v2_messages m
                        WHERE m.task_id = supertag_v2_proactive_posts.task_id)
WHERE conversation_seq IS NOT NULL;

DROP TABLE supertag_v2_m118_turns;
DROP TABLE supertag_v2_m118_history;

-- 7. The old message and read tables go, with their watch triggers.
DROP TABLE supertag_v2_conversation_reads;
DROP FUNCTION supertag_v2_watch_conversation_read();
DROP TABLE supertag_v2_conversation_messages;
DROP FUNCTION supertag_v2_watch_conversation_message_created();

-- 8. A conversation Session names its conversation.
ALTER TABLE supertag_v2_conversation_sessions
    ADD COLUMN conversation_id TEXT REFERENCES supertag_v2_conversations(conversation_id);
UPDATE supertag_v2_conversation_sessions s
SET conversation_id = c.conversation_id
FROM supertag_v2_conversations c
WHERE c.direct_key = 'p:' || s.principal || chr(10) || 't:' || s.tag_id;
ALTER TABLE supertag_v2_conversation_sessions ALTER COLUMN conversation_id SET NOT NULL;
CREATE INDEX supertag_v2_conversation_sessions_conversation
    ON supertag_v2_conversation_sessions (conversation_id, created_order);

-- 9. A Task's audience: a conversation's turn is one of its messages.
CREATE VIEW supertag_v2_task_audience AS
SELECT t.task_id, t.tag_id, t.session_id, COALESCE(o.objective_id, ws.objective_id, '') AS objective_id,
       '' AS conversation,
       COALESCE(c.principal, parent.principal,
                CASE WHEN substr(obj.created_by, 1, 7) = 'client:' THEN obj.created_by END, '') AS owner
FROM supertag_v2_tasks t
LEFT JOIN supertag_v2_messages m ON m.task_id = t.task_id
LEFT JOIN supertag_v2_conversation_sessions c ON c.session_id = t.session_id AND c.tag_id = t.tag_id
LEFT JOIN supertag_v2_work_session_tasks wt ON wt.task_id = t.task_id
LEFT JOIN supertag_v2_work_sessions ws ON ws.work_session_id = wt.work_session_id
LEFT JOIN supertag_v2_conversation_sessions parent ON parent.session_id = ws.parent_session_id
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

-- 10. A turn entering a conversation is a Task and a conversation notice, as before; a report's
-- notices come from its Work Session link (0027). The watch triggers come after the copy, so
-- migrated turns announce nothing.
CREATE FUNCTION supertag_v2_watch_conversation_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 2, 1, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks WHERE task_id = NEW.task_id
          AND NOT EXISTS (SELECT 1 FROM supertag_v2_work_session_tasks r
                          WHERE r.task_id = NEW.task_id AND r.kind = 2);
    INSERT INTO supertag_v2_watch_append
        SELECT 3, 1, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks WHERE task_id = NEW.task_id
          AND NOT EXISTS (SELECT 1 FROM supertag_v2_work_session_tasks r
                          WHERE r.task_id = NEW.task_id AND r.kind = 2);
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_conversation_turn AFTER INSERT ON supertag_v2_messages
FOR EACH ROW WHEN (NEW.task_id IS NOT NULL) EXECUTE FUNCTION supertag_v2_watch_conversation_turn();
-- Marking a conversation read tells the person's other clients.
CREATE FUNCTION supertag_v2_watch_conversation_read() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 3, 2, t.member_id, t.member_id, '', '', '', '', NEW.member_id
        FROM supertag_v2_conversation_members t
        WHERE t.conversation_id = NEW.conversation_id AND t.member_kind = 1;
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_conversation_read AFTER UPDATE OF read_seq ON supertag_v2_conversation_members
FOR EACH ROW WHEN (NEW.member_kind = 2 AND NEW.read_seq <> OLD.read_seq)
EXECUTE FUNCTION supertag_v2_watch_conversation_read();

UPDATE supertag_v2_schema SET version=118 WHERE version=117;
