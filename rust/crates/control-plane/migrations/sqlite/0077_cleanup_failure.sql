-- The Worker Host's redacted reasons when it could not confirm the current Attempt's cleanup,
-- as a JSON array, for the Task execution report. Cleared when a new Attempt claims the Task
-- and when the host later confirms cleanup.
ALTER TABLE supertag_v2_tasks ADD COLUMN cleanup_failure TEXT;
UPDATE supertag_v2_schema SET version=77 WHERE version=76;
