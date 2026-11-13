-- Manifest managers own runsOn labels by value, beside Role assignments and Mailbox grants.
ALTER TABLE supertag_v2_manifest_relationships DROP CONSTRAINT supertag_v2_manifest_relationships_kind_check;
ALTER TABLE supertag_v2_manifest_relationships ADD CONSTRAINT supertag_v2_manifest_relationships_kind_check
    CHECK (kind IN ('roles', 'acceptsMessagesFrom', 'runsOn'));

UPDATE supertag_v2_schema SET version=69 WHERE version=68;
