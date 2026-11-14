CREATE TABLE supertag_v2_artifact_sources (
    host_id TEXT PRIMARY KEY REFERENCES supertag_v2_hosts(host_id),
    host_generation BIGINT NOT NULL,
    storage_id TEXT NOT NULL
);
CREATE TABLE supertag_v2_artifact_host_copies (
    artifact_id TEXT PRIMARY KEY REFERENCES supertag_v2_artifact_captures(artifact_id),
    host_id TEXT NOT NULL REFERENCES supertag_v2_hosts(host_id),
    storage_id TEXT NOT NULL
);
CREATE TABLE supertag_v2_artifact_transfer_grants (
    token_digest BYTEA PRIMARY KEY,
    acquisition_id TEXT NOT NULL REFERENCES supertag_v2_artifact_acquisitions(acquisition_id),
    consumer_host_id TEXT NOT NULL,
    consumer_generation BIGINT NOT NULL,
    source_host_id TEXT NOT NULL,
    source_generation BIGINT NOT NULL,
    source_storage_id TEXT NOT NULL,
    path TEXT NOT NULL,
    expires_at_ms BIGINT NOT NULL
);
CREATE INDEX supertag_v2_artifact_transfer_grants_expiry ON supertag_v2_artifact_transfer_grants(expires_at_ms);
CREATE INDEX supertag_v2_artifact_transfer_grants_consumer ON supertag_v2_artifact_transfer_grants(consumer_host_id, consumer_generation, expires_at_ms);
UPDATE supertag_v2_schema SET version=54 WHERE version=53;
