-- A Tag may keep up to 1,024 Work Sessions open (maxWorkSessions), up from 64: helper pools run
-- them across contributed Worker Hosts, whose concurrency bounds what runs at once.
ALTER TABLE supertag_v2_tags DROP CONSTRAINT supertag_v2_tags_max_work_sessions_check;
ALTER TABLE supertag_v2_tags ADD CONSTRAINT supertag_v2_tags_max_work_sessions_check
    CHECK (max_work_sessions BETWEEN 1 AND 1024);
UPDATE supertag_v2_schema SET version=129 WHERE version=128;
