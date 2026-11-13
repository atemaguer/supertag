-- SQLite: Worker Host labels, Tag runsOn, and reusable or ephemeral Auth Keys.
ALTER TABLE supertag_v2_tags ADD COLUMN runs_on TEXT NOT NULL DEFAULT '[]';

ALTER TABLE supertag_v2_auth_keys ADD COLUMN reusable BIGINT NOT NULL DEFAULT 0 CHECK (reusable IN (0, 1));
ALTER TABLE supertag_v2_auth_keys ADD COLUMN ephemeral BIGINT NOT NULL DEFAULT 0 CHECK (ephemeral IN (0, 1));
ALTER TABLE supertag_v2_auth_keys ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
-- The public key ID names a key for revocation. It is the start of the secret's
-- digest, which does not authorize anything.
ALTER TABLE supertag_v2_auth_keys ADD COLUMN key_id TEXT;
UPDATE supertag_v2_auth_keys SET key_id=substr(key_digest, 1, 16);
CREATE UNIQUE INDEX supertag_v2_auth_keys_key_id ON supertag_v2_auth_keys(key_id);
-- A revoked key enrolls no more hosts. Hosts that already joined keep their enrollment.
ALTER TABLE supertag_v2_auth_keys ADD COLUMN revoked_at_ms BIGINT;

-- A reusable key enrolls many hosts. Each join keeps its own replay fingerprint.
CREATE TABLE supertag_v2_auth_key_enrollments (
    key_digest TEXT NOT NULL REFERENCES supertag_v2_auth_keys(key_digest),
    host_id TEXT NOT NULL REFERENCES supertag_v2_hosts(host_id),
    enrollment_digest TEXT NOT NULL,
    enrolled_at_ms BIGINT NOT NULL,
    PRIMARY KEY (key_digest, host_id)
);

ALTER TABLE supertag_v2_hosts ADD COLUMN ephemeral BIGINT NOT NULL DEFAULT 0 CHECK (ephemeral IN (0, 1));
ALTER TABLE supertag_v2_hosts ADD COLUMN granted_labels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE supertag_v2_hosts ADD COLUMN removed_at_ms BIGINT;
CREATE INDEX supertag_v2_hosts_ephemeral ON supertag_v2_hosts(ephemeral, revoked_at_ms);

ALTER TABLE supertag_v2_host_readiness ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';

UPDATE supertag_v2_schema SET version=59 WHERE version=58;
