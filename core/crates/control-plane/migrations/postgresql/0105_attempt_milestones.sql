-- When each Attempt's Workspace was ready, its harness adapter attached, and its harness's first
-- event arrived, by the Control Plane's clock, for the path to the first model token in
-- `supertag metrics`.
ALTER TABLE supertag_v2_claims ADD COLUMN workspace_ready_at_ms BIGINT;
ALTER TABLE supertag_v2_claims ADD COLUMN attached_at_ms BIGINT;
ALTER TABLE supertag_v2_claims ADD COLUMN first_event_at_ms BIGINT;
UPDATE supertag_v2_schema SET version=105 WHERE version=104;
