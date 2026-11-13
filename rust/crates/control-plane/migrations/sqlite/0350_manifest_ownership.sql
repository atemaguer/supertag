-- Manifest managers own runsOn labels by value, beside Role assignments and Mailbox grants.
CREATE TABLE supertag_v2_manifest_relationships_next (
    tag_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('roles', 'acceptsMessagesFrom', 'runsOn')),
    related_id TEXT NOT NULL,
    manager TEXT NOT NULL,
    observed_version TEXT NOT NULL,
    PRIMARY KEY (tag_id, kind, related_id)
);
INSERT INTO supertag_v2_manifest_relationships_next (tag_id, kind, related_id, manager, observed_version)
    SELECT tag_id, kind, related_id, manager, observed_version FROM supertag_v2_manifest_relationships;
DROP TABLE supertag_v2_manifest_relationships;
ALTER TABLE supertag_v2_manifest_relationships_next RENAME TO supertag_v2_manifest_relationships;

-- The manager that owns each manifest field, with a digest of the value it applied.
CREATE TABLE supertag_v2_manifest_fields (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    manager TEXT NOT NULL,
    value_digest TEXT NOT NULL,
    PRIMARY KEY (kind, name, path)
);

UPDATE supertag_v2_schema SET version=69 WHERE version=68;
