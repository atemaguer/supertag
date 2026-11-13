CREATE TABLE supertag_v2_apply_set_members (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    apply_set TEXT NOT NULL,
    -- NULL while the set has claimed the resource but not yet recorded creating it.
    observed_revision BIGINT,
    PRIMARY KEY (kind, name)
);
CREATE INDEX supertag_v2_apply_set_members_set ON supertag_v2_apply_set_members(apply_set, kind, name);
UPDATE supertag_v2_schema SET version=55 WHERE version=54;
