-- Removing a User: their devices, Worker Hosts, and invite keys are revoked, and what they owned
-- moves to another User. The User stays as a record, so their name is never reused.
ALTER TABLE supertag_v2_users ADD COLUMN removed_at_ms BIGINT;
ALTER TABLE supertag_v2_users ADD COLUMN transferred_to TEXT REFERENCES supertag_v2_users(name);

UPDATE supertag_v2_schema SET version=127 WHERE version=126;
