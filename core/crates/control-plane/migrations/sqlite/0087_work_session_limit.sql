-- Work Session limit per Tag. A Tag may have `max_work_sessions` Work Sessions open at once (1 to
-- 64, default 8), counted across all its conversations and Objectives by the Tag that started them.
-- A Work Session is open until it closes: by `close_session`, an operator, a pulled delivery, or
-- its Objective closing. `close_reason` is a WorkSessionCloseReason.
ALTER TABLE supertag_v2_tags ADD COLUMN max_work_sessions BIGINT NOT NULL DEFAULT 8
    CHECK (max_work_sessions BETWEEN 1 AND 64);
ALTER TABLE supertag_v2_work_sessions ADD COLUMN closed_at_ms BIGINT;
ALTER TABLE supertag_v2_work_sessions ADD COLUMN close_reason SMALLINT NOT NULL DEFAULT 0;
CREATE INDEX supertag_v2_work_sessions_open
    ON supertag_v2_work_sessions (parent_tag_id, closed_at_ms);

-- Work Sessions that had finished before SuperTag counted open ones close now, so no Tag starts
-- at its limit. Each Tag's four newest stay open to be continued, and so does one waiting on an
-- answer to its question.
UPDATE supertag_v2_work_sessions SET closed_at_ms = CAST(strftime('%s', 'now') AS BIGINT) * 1000, close_reason = 5
WHERE EXISTS (SELECT 1 FROM supertag_v2_tasks t WHERE t.task_id = supertag_v2_work_sessions.latest_task_id
              AND t.state IN (3, 4, 5) AND t.cleanup_pending = 0)
  AND (SELECT COUNT(*) FROM supertag_v2_work_sessions newer
       WHERE newer.parent_tag_id = supertag_v2_work_sessions.parent_tag_id
         AND newer.created_order > supertag_v2_work_sessions.created_order) >= 4
  AND NOT EXISTS (SELECT 1 FROM supertag_v2_work_session_questions q
                  WHERE q.work_session_id = supertag_v2_work_sessions.work_session_id
                    AND q.published_at_ms IS NOT NULL AND q.answer_task_id IS NULL);

UPDATE supertag_v2_schema SET version=86 WHERE version=85;
