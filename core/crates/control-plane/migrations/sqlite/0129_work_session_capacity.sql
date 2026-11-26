-- A Tag may keep up to 1,024 Work Sessions open (maxWorkSessions), up from 64: helper pools run
-- them across contributed Worker Hosts, whose concurrency bounds what runs at once.
ALTER TABLE supertag_v2_tags ADD COLUMN next_max_work_sessions BIGINT NOT NULL DEFAULT 8
    CHECK (next_max_work_sessions BETWEEN 1 AND 1024);
UPDATE supertag_v2_tags SET next_max_work_sessions = max_work_sessions;
ALTER TABLE supertag_v2_tags DROP COLUMN max_work_sessions;
ALTER TABLE supertag_v2_tags RENAME COLUMN next_max_work_sessions TO max_work_sessions;
UPDATE supertag_v2_schema SET version=129 WHERE version=128;
