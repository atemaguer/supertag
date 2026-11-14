CREATE TABLE supertag_v2_work_sessions (
    work_session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    parent_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    parent_session_id TEXT NOT NULL,
    starter_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    latest_task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    objective_id TEXT REFERENCES supertag_v2_objectives(objective_id),
    created_order BIGINT NOT NULL UNIQUE
);
CREATE INDEX supertag_v2_work_sessions_parent
    ON supertag_v2_work_sessions (parent_tag_id, parent_session_id, created_order);
CREATE INDEX supertag_v2_work_sessions_starter
    ON supertag_v2_work_sessions (starter_task_id, created_order);

CREATE TABLE supertag_v2_work_session_tasks (
    task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    work_session_id TEXT NOT NULL REFERENCES supertag_v2_work_sessions(work_session_id),
    kind BIGINT NOT NULL CHECK (kind IN (1, 2))
);
CREATE INDEX supertag_v2_work_session_tasks_session
    ON supertag_v2_work_session_tasks (work_session_id, kind);

CREATE TABLE supertag_v2_work_session_starts (
    starter_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    work_session_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_work_sessions(work_session_id),
    PRIMARY KEY (starter_task_id, operation_id)
);

CREATE TABLE supertag_v2_work_session_reports (
    child_task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    work_session_id TEXT NOT NULL REFERENCES supertag_v2_work_sessions(work_session_id),
    report_task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    created_order BIGINT NOT NULL UNIQUE
);
CREATE INDEX supertag_v2_work_session_reports_session
    ON supertag_v2_work_session_reports (work_session_id, created_order);


-- Work Session Tasks inherit the parent conversation's audience. Reserved
-- Sessions are invisible until their durable source relationship is recorded.
CREATE VIEW supertag_v2_task_audience AS
SELECT t.task_id, t.tag_id, t.session_id, COALESCE(o.objective_id, ws.objective_id, '') AS objective_id,
       COALESCE(c.name, parent.name, '') AS conversation,
       COALESCE(c.principal, parent.principal, '') AS owner
FROM supertag_v2_tasks t
LEFT JOIN supertag_v2_conversation_messages m ON m.task_id = t.task_id
LEFT JOIN supertag_v2_conversations c ON c.session_id = t.session_id AND c.tag_id = t.tag_id
LEFT JOIN supertag_v2_work_session_tasks wt ON wt.task_id = t.task_id
LEFT JOIN supertag_v2_work_sessions ws ON ws.work_session_id = wt.work_session_id
LEFT JOIN supertag_v2_conversations parent ON parent.session_id = ws.parent_session_id
    AND parent.tag_id = ws.parent_tag_id
LEFT JOIN supertag_v2_objective_tasks o ON o.task_id = t.task_id
WHERE (substr(t.session_id, 1, 5) <> 'work/'
       OR (wt.kind = 1 AND ws.work_session_id = t.session_id AND ws.tag_id = t.tag_id
           AND (substr(ws.parent_session_id, 1, 13) <> 'conversation/' OR parent.session_id IS NOT NULL)))
  AND (substr(t.session_id, 1, 13) <> 'conversation/'
       OR (c.session_id IS NOT NULL AND (m.task_id IS NOT NULL
           OR (wt.kind = 2 AND ws.parent_session_id = t.session_id AND ws.parent_tag_id = t.tag_id))));

-- Report Tasks are real history entries, without fabricating user-message receipts.
CREATE VIEW supertag_v2_conversation_history AS
SELECT m.task_id, m.session_id, m.accepted_order, CAST(NULL AS TEXT) AS work_session_report_id
FROM supertag_v2_conversation_messages m
UNION ALL
SELECT t.task_id, t.session_id, t.accepted_order, ws.work_session_id
FROM supertag_v2_work_session_tasks wt
JOIN supertag_v2_work_sessions ws ON ws.work_session_id = wt.work_session_id
JOIN supertag_v2_tasks t ON t.task_id = wt.task_id AND t.session_id = ws.parent_session_id
    AND t.tag_id = ws.parent_tag_id
WHERE wt.kind = 2;

DROP VIEW supertag_v2_watch_tasks;
CREATE VIEW supertag_v2_watch_tasks AS
SELECT task_id, tag_id, session_id, objective_id, conversation, owner
FROM supertag_v2_task_audience;

CREATE TRIGGER supertag_v2_watch_work_session_task_linked AFTER INSERT ON supertag_v2_work_session_tasks
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 2, 1, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks
        WHERE task_id = NEW.task_id AND (NEW.kind = 1 OR owner <> '');
    INSERT INTO supertag_v2_watch_append
        SELECT 3, 1, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks
        WHERE task_id = NEW.task_id AND NEW.kind = 2 AND owner <> '';
END;

UPDATE supertag_v2_schema SET version=27 WHERE version=26;
