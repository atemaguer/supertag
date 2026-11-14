-- Limits the current Attempt's adapter confirmed it applies, for the Task execution report.
-- Cleared whenever a new Attempt claims the Task.
ALTER TABLE supertag_v2_tasks ADD COLUMN applied_execution_limits BLOB;
UPDATE supertag_v2_schema SET version=71 WHERE version=70;
