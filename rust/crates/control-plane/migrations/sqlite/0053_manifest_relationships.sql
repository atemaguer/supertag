CREATE TABLE supertag_v2_manifest_relationships (
    tag_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('roles', 'acceptsMessagesFrom')),
    related_id TEXT NOT NULL,
    manager TEXT NOT NULL,
    observed_version TEXT NOT NULL,
    PRIMARY KEY (tag_id, kind, related_id)
);

UPDATE supertag_v2_schema SET version=53;
