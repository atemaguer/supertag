ALTER TABLE supertag_v2_tags ADD COLUMN work_session_harness TEXT NOT NULL DEFAULT '';
UPDATE supertag_v2_schema SET version=130 WHERE version=129;
