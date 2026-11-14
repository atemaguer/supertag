-- SQLite: operator-chosen Auth Key names replace the digest-derived key ID. A name is never reused.
ALTER TABLE supertag_v2_auth_keys ADD COLUMN name TEXT;
UPDATE supertag_v2_auth_keys SET name=key_id;
DROP INDEX supertag_v2_auth_keys_key_id;
ALTER TABLE supertag_v2_auth_keys DROP COLUMN key_id;
CREATE UNIQUE INDEX supertag_v2_auth_keys_name ON supertag_v2_auth_keys(name);
ALTER TABLE supertag_v2_auth_keys ADD COLUMN created_at_ms BIGINT NOT NULL DEFAULT 0;
CREATE INDEX supertag_v2_auth_keys_created ON supertag_v2_auth_keys(created_at_ms, name);

-- Increases with every Worker Host credential rotation, from 1.
ALTER TABLE supertag_v2_hosts ADD COLUMN credential_revision BIGINT NOT NULL DEFAULT 1 CHECK (credential_revision > 0);

UPDATE supertag_v2_schema SET version=66 WHERE version=65;
