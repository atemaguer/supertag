ALTER TABLE supertag_v2_tags ADD COLUMN execution BYTEA;
UPDATE supertag_v2_schema SET version=36 WHERE version=35;
