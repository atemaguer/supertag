-- The Worker Host holding a running Attempt's Session continuation, which the Attempt waits for
-- because it is not connected. Set by the Attempt's host, cleared when the Attempt goes on, a new
-- Attempt claims the Task, or the Task finishes.
ALTER TABLE supertag_v2_tasks ADD COLUMN waiting_holder TEXT;

UPDATE supertag_v2_schema SET version=95 WHERE version=94;
