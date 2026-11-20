-- Redelivery after a lost Worker (operator decision, 2026-11-19): a Task whose reclaimed Attempt
-- did nothing that cannot be repeated is queued again, and not claimed before its backoff ends.
ALTER TABLE supertag_v2_tasks ADD COLUMN redeliver_after_ms BIGINT;
-- Why a reclaimed Attempt's Task was not redelivered; the operator Inbox shows it.
ALTER TABLE supertag_v2_attempt_resolutions ADD COLUMN not_redelivered_reason TEXT;

UPDATE supertag_v2_schema SET version=120 WHERE version=119;
