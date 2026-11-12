ALTER TABLE supertag_v2_tasks ADD COLUMN input_artifacts BLOB;
UPDATE supertag_v2_schema SET version=49 WHERE version=48;
