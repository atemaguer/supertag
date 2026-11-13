CREATE TABLE supertag_v2_workspace_volumes (
    volume_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK(revision > 0)
);
ALTER TABLE supertag_v2_tags ADD COLUMN workspace_mounts BYTEA;
ALTER TABLE supertag_v2_tasks ADD COLUMN workspace_mounts BYTEA;
UPDATE supertag_v2_schema SET version=55 WHERE version=54;
