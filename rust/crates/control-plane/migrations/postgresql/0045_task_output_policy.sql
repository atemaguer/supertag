ALTER TABLE supertag_v2_tasks ADD COLUMN output_policy BYTEA;
UPDATE supertag_v2_schema SET version=45 WHERE version=44;
