-- When an Objective last ended a turn with nothing running and nothing asked while it still had
-- work to do. The Objective stays working; only report_objective changes its status from a turn.
ALTER TABLE supertag_v2_objectives ADD COLUMN idle_since_ms BIGINT;

UPDATE supertag_v2_schema SET version=104 WHERE version=103;
