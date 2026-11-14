-- Spend reports group and filter Attempts by when they were claimed. Earlier
-- claims have no recorded time and are reported as undated.
ALTER TABLE supertag_v2_claims ADD COLUMN claimed_at_ms BIGINT;
UPDATE supertag_v2_schema SET version=63 WHERE version=62;
