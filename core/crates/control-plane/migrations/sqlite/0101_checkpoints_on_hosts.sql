-- Session checkpoints move off the Control Plane: their bytes stay with the Worker Host that wrote
-- them, and the Control Plane keeps only who holds each one. The bytes stored until now were the
-- Control Plane's own, so their rows go and each Session's next turn starts from its recap.
DELETE FROM supertag_v2_session_checkpoints;
DELETE FROM supertag_v2_checkpoints;
ALTER TABLE supertag_v2_checkpoints ADD COLUMN holder_host_id TEXT;
DROP TABLE supertag_v2_checkpoint_garbage;
UPDATE supertag_v2_schema SET version=101 WHERE version=100;
