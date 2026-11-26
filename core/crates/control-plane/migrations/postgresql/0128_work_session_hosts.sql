-- Helper pools: a Worker Host may be bound to a Tag for its Work Sessions only. It claims the
-- Tag's Tasks in `work/...` Sessions and never its conversations, inbox, Objective Sessions,
-- reports, reviews, or Schedule fires. A host Auth Key lists those Tags apart from the Tags its
-- hosts run in full.
ALTER TABLE supertag_v2_auth_keys ADD COLUMN work_session_tag_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE supertag_v2_host_tags ADD COLUMN work_sessions_only INTEGER NOT NULL DEFAULT 0;

UPDATE supertag_v2_schema SET version=128 WHERE version=127;
