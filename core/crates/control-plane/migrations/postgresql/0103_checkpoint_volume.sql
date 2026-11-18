-- The Volume a Session checkpoint was written to, by a Worker Host granted it; NULL when only its
-- holder keeps it.
ALTER TABLE supertag_v2_checkpoints ADD COLUMN volume_id TEXT;

UPDATE supertag_v2_schema SET version=103 WHERE version=102;
