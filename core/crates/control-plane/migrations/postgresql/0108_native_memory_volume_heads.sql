-- A native memory store kept on its Tag's Volume: the Control Plane holds only the pointer to the
-- store's current manifest, an immutable blob on the Volume, and moves it by compare-and-set on
-- the revision. One per Tag, harness, and audience ('' for the shared store), on one Volume.
CREATE TABLE supertag_v2_native_memory_volume_heads (
  tag_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  audience_principal TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_bytes BIGINT NOT NULL,
  files BIGINT NOT NULL,
  bytes BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (tag_id, harness, audience_principal)
);

UPDATE supertag_v2_schema SET version=108 WHERE version=107;
