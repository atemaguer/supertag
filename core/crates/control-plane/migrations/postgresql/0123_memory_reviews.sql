-- A Tag reviews each of its memory stores: the shared store from the Tag's shared work, and each
-- person's store from that person's own Sessions. One row per Tag and audience ('' for shared)
-- counts the turns whose changes were the Tag's own since that store's last review, and names the
-- reserved Session its reviews run in: `memory:TAG` for the shared store, and for a person's
-- `memory:TAG:SCOPE`, private to that person. The shared store's last review moves here; the
-- Tag's memory_reviewed_at_ms now says when it last reviewed any of its stores.
CREATE TABLE supertag_v2_memory_reviews (
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    audience_principal TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turns BIGINT NOT NULL DEFAULT 0,
    first_turn_at_ms BIGINT NOT NULL,
    reviewed_at_ms BIGINT,
    review_task_id TEXT,
    PRIMARY KEY (tag_id, audience_principal)
);
CREATE UNIQUE INDEX supertag_v2_memory_reviews_session
    ON supertag_v2_memory_reviews (tag_id, session_id);
INSERT INTO supertag_v2_memory_reviews
    (tag_id, audience_principal, session_id, turns, first_turn_at_ms, reviewed_at_ms, review_task_id)
SELECT tag_id, '', 'memory:' || tag_id, 0, memory_reviewed_at_ms, memory_reviewed_at_ms,
       memory_review_task_id
FROM supertag_v2_tags WHERE memory_reviewed_at_ms IS NOT NULL AND retired_at_ms IS NULL;
ALTER TABLE supertag_v2_tags DROP COLUMN memory_review_task_id;

-- A person's review turn is theirs: its Task's audience owner is that person, as for their
-- conversation's turns. The same columns, so the views built on it stay.
CREATE OR REPLACE VIEW supertag_v2_task_audience AS
SELECT t.task_id, t.tag_id, t.session_id, COALESCE(o.objective_id, ws.objective_id, '') AS objective_id,
       '' AS conversation,
       COALESCE(c.principal, parent.principal,
                CASE WHEN substr(obj.created_by, 1, 7) = 'client:' THEN obj.created_by END,
                NULLIF(mr.audience_principal, ''), '') AS owner
FROM supertag_v2_tasks t
LEFT JOIN supertag_v2_messages m ON m.task_id = t.task_id
LEFT JOIN supertag_v2_conversation_sessions c ON c.session_id = t.session_id AND c.tag_id = t.tag_id
LEFT JOIN supertag_v2_work_session_tasks wt ON wt.task_id = t.task_id
LEFT JOIN supertag_v2_work_sessions ws ON ws.work_session_id = wt.work_session_id
LEFT JOIN supertag_v2_conversation_sessions parent ON parent.session_id = ws.parent_session_id
    AND parent.tag_id = ws.parent_tag_id
LEFT JOIN supertag_v2_objective_tasks o ON o.task_id = t.task_id
LEFT JOIN supertag_v2_objectives obj ON obj.objective_id = COALESCE(o.objective_id, ws.objective_id)
LEFT JOIN supertag_v2_memory_reviews mr ON mr.tag_id = t.tag_id AND mr.session_id = t.session_id
WHERE (substr(t.session_id, 1, 5) <> 'work/'
       OR (wt.kind = 1 AND ws.work_session_id = t.session_id AND ws.tag_id = t.tag_id
           AND (substr(ws.parent_session_id, 1, 13) <> 'conversation/' OR parent.session_id IS NOT NULL)))
  AND (substr(t.session_id, 1, 13) <> 'conversation/'
       OR (c.session_id IS NOT NULL AND (m.task_id IS NOT NULL
           OR (wt.kind = 2 AND ws.parent_session_id = t.session_id AND ws.parent_tag_id = t.tag_id))));

UPDATE supertag_v2_schema SET version=123 WHERE version=122;
