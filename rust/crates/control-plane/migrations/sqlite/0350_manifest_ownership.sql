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

UPDATE supertag_v2_schema SET version=69 WHERE version=68;
