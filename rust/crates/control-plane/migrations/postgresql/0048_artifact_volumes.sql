CREATE TABLE supertag_v2_artifact_volumes (
    volume_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK(revision > 0),
    deleted BIGINT NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE TABLE supertag_v2_artifact_volume_operations (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response BYTEA NOT NULL,
    PRIMARY KEY(principal,operation_id)
);
CREATE TABLE supertag_v2_artifact_volume_copies (
    copy_id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    volume_id TEXT NOT NULL REFERENCES supertag_v2_artifact_volumes(volume_id),
    artifact_id TEXT NOT NULL REFERENCES supertag_v2_artifact_captures(artifact_id),
    request_digest TEXT NOT NULL,
    state BIGINT NOT NULL CHECK(state IN (1,2)),
    payload BYTEA NOT NULL,
    created_order BIGINT NOT NULL UNIQUE,
    UNIQUE(principal,operation_id)
);
CREATE INDEX supertag_v2_artifact_volume_copy_locations ON supertag_v2_artifact_volume_copies(volume_id,created_order);
UPDATE supertag_v2_schema SET version=48 WHERE version=47;
