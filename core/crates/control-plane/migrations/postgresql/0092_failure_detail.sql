-- The Worker Host's redacted reasons behind a failed Attempt's fixed result, as a JSON array, for
-- the operator's Task execution report. Cleared when a new Attempt claims the Task.
ALTER TABLE supertag_v2_tasks ADD COLUMN failure_detail TEXT;
UPDATE supertag_v2_schema SET version=92 WHERE version=91;
