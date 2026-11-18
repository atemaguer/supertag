-- Native memory objects a Worker Host was granted to write to a Volume and no store names yet.
-- A host writes an object only under a grant, so these are every object that may be on the
-- Volume unnamed: one whose turn lost its head to another, or ended before moving it. Once the
-- writing Attempt no longer runs and a grace period has passed, the sweep sends the unnamed
-- ones to Volume garbage.
CREATE TABLE supertag_v2_native_memory_pending_objects (
  volume_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length BIGINT NOT NULL,
  tag_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  granted_at_ms BIGINT NOT NULL,
  PRIMARY KEY (volume_id, storage_key)
);
CREATE INDEX supertag_v2_native_memory_pending_objects_age
  ON supertag_v2_native_memory_pending_objects(granted_at_ms);

UPDATE supertag_v2_schema SET version=112 WHERE version=111;
