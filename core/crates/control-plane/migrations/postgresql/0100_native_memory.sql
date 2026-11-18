-- Harness-native memory. Worker Hosts keep the files; the Control Plane records what each host
-- holds of a Tag's store per harness and audience ('' for the shared store), and a reset
-- generation that tells hosts to drop older copies.
ALTER TABLE supertag_v2_tags ADD COLUMN native_memory_generation BIGINT NOT NULL DEFAULT 0;
CREATE TABLE supertag_v2_native_memory_stores (
  tag_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  audience_principal TEXT NOT NULL,
  host_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  files BIGINT NOT NULL,
  bytes BIGINT NOT NULL,
  digest TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (tag_id, harness, audience_principal, host_id)
);

UPDATE supertag_v2_schema SET version=100 WHERE version=99;
