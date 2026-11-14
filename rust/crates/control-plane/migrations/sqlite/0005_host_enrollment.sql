-- SQLite: scoped host enrollment and connection generations.
CREATE TABLE supertag_v2_hosts (
    host_id TEXT PRIMARY KEY,
    token_digest TEXT NOT NULL UNIQUE,
    all_tags BIGINT NOT NULL CHECK (all_tags IN (0, 1)),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    enrolled_at_ms BIGINT NOT NULL,
    revoked_at_ms BIGINT
);

CREATE TABLE supertag_v2_host_tags (
    host_id TEXT NOT NULL REFERENCES supertag_v2_hosts(host_id),
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    PRIMARY KEY (host_id, tag_id)
);

CREATE TABLE supertag_v2_host_incarnations (
    host_id TEXT NOT NULL REFERENCES supertag_v2_hosts(host_id),
    incarnation_id TEXT NOT NULL,
    generation BIGINT NOT NULL CHECK (generation > 0),
    registered_at_ms BIGINT NOT NULL,
    PRIMARY KEY (host_id, incarnation_id),
    UNIQUE (host_id, generation)
);

CREATE TABLE supertag_v2_auth_keys (
    key_digest TEXT PRIMARY KEY,
    operator_principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    host_id TEXT NOT NULL,
    allowed_tag_ids TEXT NOT NULL,
    all_tags BIGINT NOT NULL CHECK (all_tags IN (0, 1)),
    expires_at_ms BIGINT NOT NULL,
    consumed_at_ms BIGINT,
    enrollment_digest TEXT,
    UNIQUE (operator_principal, operation_id)
);

ALTER TABLE supertag_v2_tasks ADD COLUMN host_generation BIGINT CHECK (host_generation > 0);
CREATE INDEX supertag_v2_tasks_host_generation ON supertag_v2_tasks(host_principal, host_generation, state);

-- Older reservations never authorized a registered host. Preserve potentially
-- active execution for explicit recovery, and release only unstarted claims.
UPDATE supertag_v2_tasks SET state = 1, attempt_id = NULL, host_principal = NULL,
    lease_token = NULL, lease_expires_at_ms = NULL, event_sequence_base = 0
WHERE state = 6;
UPDATE supertag_v2_tasks SET state = 7, cleanup_pending = 1, lease_expires_at_ms = 0
WHERE state = 2;
UPDATE supertag_v2_tasks SET lease_expires_at_ms = 0 WHERE state = 5 AND cleanup_pending = 1;

UPDATE supertag_v2_schema SET version = 5 WHERE version = 4;
