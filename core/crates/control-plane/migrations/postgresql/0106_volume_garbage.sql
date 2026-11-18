-- Objects on a Volume that nothing keeps any more, until they are deleted: by the Control Plane
-- for an S3 Volume, by a Worker Host that maps it for a file Volume. Today these are Session
-- checkpoints whose rows were dropped; an object is kept while a checkpoint row of the same
-- Session still names its bytes on that Volume.
CREATE TABLE supertag_v2_volume_garbage (
    volume_id TEXT NOT NULL,
    source TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_length BIGINT NOT NULL,
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    queued_at_ms BIGINT NOT NULL,
    PRIMARY KEY (volume_id, storage_key)
);
CREATE INDEX supertag_v2_volume_garbage_queue ON supertag_v2_volume_garbage(volume_id, source, queued_at_ms);

UPDATE supertag_v2_schema SET version=106 WHERE version=105;
