-- Manifest managers own runsOn labels by value, beside Role assignments and Mailbox grants.
ALTER TABLE supertag_v2_manifest_relationships DROP CONSTRAINT supertag_v2_manifest_relationships_kind_check;
ALTER TABLE supertag_v2_manifest_relationships ADD CONSTRAINT supertag_v2_manifest_relationships_kind_check
    CHECK (kind IN ('roles', 'acceptsMessagesFrom', 'runsOn'));

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
