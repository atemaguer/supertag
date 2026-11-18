-- The Worker Host a Session's last Task finished on, and until when its next Task is offered
-- there first. Every Control Plane replica reads it, and it outlives a restart.
CREATE TABLE supertag_v2_warm_sessions (
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    warm_until_ms BIGINT NOT NULL,
    PRIMARY KEY (tag_id, session_id)
);
CREATE INDEX supertag_v2_warm_sessions_until ON supertag_v2_warm_sessions(warm_until_ms);

UPDATE supertag_v2_schema SET version=114 WHERE version=113;
