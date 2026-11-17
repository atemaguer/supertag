-- A Tag's start rate: at most `start_rate_starts` Task Attempt starts in any
-- `start_rate_per_ms` window. Both are NULL for a Tag without one.
ALTER TABLE supertag_v2_tags ADD COLUMN start_rate_starts BIGINT;
ALTER TABLE supertag_v2_tags ADD COLUMN start_rate_per_ms BIGINT;
-- Claims are the starts a window counts.
CREATE INDEX supertag_v2_claims_claimed_at ON supertag_v2_claims (claimed_at_ms);

UPDATE supertag_v2_schema SET version=94 WHERE version=93;
