ALTER TABLE supertag_v2_work_session_tasks ADD COLUMN starter_task_id TEXT REFERENCES supertag_v2_tasks(task_id);
UPDATE supertag_v2_work_session_tasks
SET starter_task_id = (SELECT starter_task_id FROM supertag_v2_work_sessions ws
                       WHERE ws.work_session_id = supertag_v2_work_session_tasks.work_session_id)
WHERE kind = 1;
CREATE INDEX supertag_v2_work_session_tasks_starter ON supertag_v2_work_session_tasks(starter_task_id, kind);

ALTER TABLE supertag_v2_work_session_starts ADD COLUMN child_task_id TEXT REFERENCES supertag_v2_tasks(task_id);
UPDATE supertag_v2_work_session_starts
SET child_task_id = (SELECT latest_task_id FROM supertag_v2_work_sessions ws
                     WHERE ws.work_session_id = supertag_v2_work_session_starts.work_session_id);

CREATE TABLE supertag_v2_work_session_continuations (
    starter_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    work_session_id TEXT NOT NULL REFERENCES supertag_v2_work_sessions(work_session_id),
    child_task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    response BYTEA NOT NULL,
    PRIMARY KEY (starter_task_id, operation_id)
);

CREATE TABLE supertag_v2_work_session_questions (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    work_session_id TEXT NOT NULL REFERENCES supertag_v2_work_sessions(work_session_id),
    operation_id TEXT NOT NULL,
    text TEXT NOT NULL,
    asked_at_ms BIGINT NOT NULL,
    published_at_ms BIGINT,
    answer_task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id)
);
CREATE INDEX supertag_v2_work_session_questions_task ON supertag_v2_work_session_questions(task_id);

UPDATE supertag_v2_schema SET version=28 WHERE version=27;
