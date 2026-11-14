-- Queue and start latencies for supertag metrics. Tasks accepted and Attempts started
-- before this migration have no recorded time and are left out of the averages.
ALTER TABLE supertag_v2_tasks ADD COLUMN accepted_at_ms BIGINT;
ALTER TABLE supertag_v2_claims ADD COLUMN started_at_ms BIGINT;
UPDATE supertag_v2_schema SET version=72 WHERE version=71;
