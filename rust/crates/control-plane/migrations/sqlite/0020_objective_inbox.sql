-- A question is staged by exact execution authority and becomes actionable only
-- with that Attempt's successful terminal outcome. Inbox items remain derived.
CREATE TABLE supertag_v2_objective_questions (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
    operation_id TEXT NOT NULL,
    text TEXT NOT NULL,
    asked_at_ms BIGINT NOT NULL,
    published_at_ms BIGINT,
    published_order BIGINT,
    answer_task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    CHECK ((published_at_ms IS NULL) = (published_order IS NULL))
);
CREATE INDEX supertag_v2_objective_questions_task ON supertag_v2_objective_questions(task_id, attempt_id);
CREATE INDEX supertag_v2_objective_questions_pending ON supertag_v2_objective_questions(objective_id, published_at_ms, task_id);
CREATE TABLE supertag_v2_question_answers (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    question_attempt_id TEXT NOT NULL REFERENCES supertag_v2_objective_questions(attempt_id),
    answer_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (principal, operation_id)
);
UPDATE supertag_v2_schema SET version = 20 WHERE version = 19;
