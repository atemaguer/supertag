-- Host observations describe availability; they never grant execution authority.
ALTER TABLE supertag_v2_hosts ADD COLUMN draining BIGINT NOT NULL DEFAULT 0 CHECK (draining IN (0, 1));
CREATE TABLE supertag_v2_host_readiness (
    host_id TEXT PRIMARY KEY REFERENCES supertag_v2_hosts(host_id),
    generation BIGINT NOT NULL CHECK (generation > 0),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    request_digest TEXT NOT NULL,
    capacity BIGINT NOT NULL CHECK (capacity >= 0 AND capacity <= 1024),
    available_slots BIGINT NOT NULL CHECK (available_slots >= 0 AND available_slots <= capacity),
    readiness BIGINT NOT NULL CHECK (readiness IN (1, 2, 3)),
    reason BIGINT NOT NULL CHECK (reason IN (0, 1, 2, 3)),
    harness_kind BIGINT NOT NULL CHECK (harness_kind IN (0, 1, 2, 3)),
    workspace_ids TEXT NOT NULL,
    last_seen_at_ms BIGINT NOT NULL,
    presence_expires_at_ms BIGINT NOT NULL
);
UPDATE supertag_v2_schema SET version = 19 WHERE version = 18;
