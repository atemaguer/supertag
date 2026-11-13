ALTER TABLE supertag_v2_tasks ADD COLUMN completed_at_ms BIGINT;
CREATE TABLE supertag_v2_artifact_context_grants (
 task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
 artifact_id TEXT NOT NULL REFERENCES supertag_v2_artifact_captures(artifact_id),
 PRIMARY KEY(task_id,artifact_id)
);
UPDATE supertag_v2_schema SET version=51 WHERE version=50;
