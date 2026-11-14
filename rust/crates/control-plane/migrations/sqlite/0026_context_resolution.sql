CREATE TABLE supertag_v2_context_resolutions (
    task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    first_attempt_id TEXT NOT NULL,
    manifest BLOB NOT NULL
);
CREATE TABLE supertag_v2_attempt_context_resolutions (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id)
);
ALTER TABLE supertag_v2_claims ADD COLUMN context_scope TEXT NOT NULL DEFAULT '[]';
UPDATE supertag_v2_schema SET version=26 WHERE version=25;
