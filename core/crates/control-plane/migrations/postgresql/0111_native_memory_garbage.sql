-- The objects each native memory store on a Volume names now: its manifest and the files the
-- manifest names. An object no store names any more goes to Volume garbage.
CREATE TABLE supertag_v2_native_memory_volume_objects (
  tag_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  audience_principal TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length BIGINT NOT NULL,
  PRIMARY KEY (tag_id, harness, audience_principal, storage_key)
);
CREATE INDEX supertag_v2_native_memory_volume_objects_key
  ON supertag_v2_native_memory_volume_objects(volume_id, storage_key);
-- What kind of object a garbage row is, which decides what keeps it: a Session checkpoint, or a
-- native memory object (its session_id is '').
ALTER TABLE supertag_v2_volume_garbage ADD COLUMN kind TEXT NOT NULL DEFAULT 'checkpoint';

UPDATE supertag_v2_schema SET version=111 WHERE version=110;
