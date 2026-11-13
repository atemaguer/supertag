-- A Host may serve several harnesses, each with its own concurrent Attempt slots.
ALTER TABLE supertag_v2_host_readiness ADD COLUMN harnesses BYTEA;
UPDATE supertag_v2_schema SET version=57 WHERE version=56;
