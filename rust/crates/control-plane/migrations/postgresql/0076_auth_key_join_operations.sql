-- A reusable Auth Key's host join is found again by the operation that requested it, because the
-- host it enrolled may carry a NAME-2 suffix when the requested name was taken. Joins recorded
-- before this migration keep a NULL operation and are found by their name.
ALTER TABLE supertag_v2_auth_key_joins ADD COLUMN operation_digest TEXT;
CREATE UNIQUE INDEX supertag_v2_auth_key_join_operations ON supertag_v2_auth_key_joins(key_digest, role, operation_digest);
UPDATE supertag_v2_schema SET version=76 WHERE version=75;
