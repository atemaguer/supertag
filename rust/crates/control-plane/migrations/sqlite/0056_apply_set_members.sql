CREATE TABLE supertag_v2_apply_set_members (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    apply_set TEXT NOT NULL,
    observed_revision BIGINT NOT NULL,
    PRIMARY KEY (kind, name)
);
CREATE INDEX supertag_v2_apply_set_members_set ON supertag_v2_apply_set_members(apply_set, kind, name);
UPDATE supertag_v2_schema SET version=56 WHERE version=55;
