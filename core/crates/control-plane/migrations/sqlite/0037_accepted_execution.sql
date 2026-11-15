ALTER TABLE supertag_v2_tasks ADD COLUMN execution_selection BLOB;
UPDATE supertag_v2_schema SET version=37 WHERE version=36;
