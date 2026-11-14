ALTER TABLE supertag_v2_tasks ADD COLUMN result_artifacts BYTEA;
UPDATE supertag_v2_schema SET version=43 WHERE version=42;
