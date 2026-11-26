PRAGMA defer_foreign_keys = ON;
CREATE TABLE supertag_v2_objective_questions_new (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    objective_id TEXT REFERENCES supertag_v2_objectives(objective_id),
    recipient_user TEXT,
    operation_id TEXT NOT NULL,
    text TEXT NOT NULL,
    asked_at_ms BIGINT NOT NULL,
    published_at_ms BIGINT,
    published_order BIGINT,
    answer_task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    CHECK ((published_at_ms IS NULL) = (published_order IS NULL)),
    CHECK ((objective_id IS NULL) <> (recipient_user IS NULL))
);
INSERT INTO supertag_v2_objective_questions_new (attempt_id,task_id,objective_id,operation_id,text,asked_at_ms,published_at_ms,published_order,answer_task_id)
SELECT attempt_id,task_id,objective_id,operation_id,text,asked_at_ms,published_at_ms,published_order,answer_task_id FROM supertag_v2_objective_questions;
DROP TABLE supertag_v2_objective_questions;
ALTER TABLE supertag_v2_objective_questions_new RENAME TO supertag_v2_objective_questions;
CREATE INDEX supertag_v2_objective_questions_task ON supertag_v2_objective_questions(task_id, attempt_id);
CREATE INDEX supertag_v2_objective_questions_pending ON supertag_v2_objective_questions(objective_id, published_at_ms, task_id);
UPDATE supertag_v2_schema SET version=131 WHERE version=130;
