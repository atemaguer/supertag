-- A Session keeps only its newest checkpoint. Superseded and dropped checkpoints lose their rows
-- at once; their files are removed later, once no row names the digest, through this queue.
CREATE TABLE supertag_v2_checkpoint_garbage (
    sha256 TEXT PRIMARY KEY,
    queued_at_ms BIGINT NOT NULL
);
CREATE INDEX supertag_v2_checkpoints_task ON supertag_v2_checkpoints(task_id);
CREATE INDEX supertag_v2_checkpoints_sha256 ON supertag_v2_checkpoints(sha256);

UPDATE supertag_v2_schema SET version=85 WHERE version=84;
