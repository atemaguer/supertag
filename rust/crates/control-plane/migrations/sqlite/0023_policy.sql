CREATE TABLE supertag_v2_permission_sets (
    set_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    revision BIGINT NOT NULL CHECK (revision > 0),
    payload BLOB NOT NULL
);
CREATE TABLE supertag_v2_context_sets (
    set_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    revision BIGINT NOT NULL CHECK (revision > 0),
    payload BLOB NOT NULL
);
CREATE TABLE supertag_v2_roles (
    role_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    revision BIGINT NOT NULL CHECK (revision > 0),
    status BIGINT NOT NULL CHECK (status IN (1,2)),
    payload BLOB NOT NULL
);
CREATE TABLE supertag_v2_role_permission_sets (
    role_id TEXT NOT NULL REFERENCES supertag_v2_roles(role_id),
    set_id TEXT NOT NULL REFERENCES supertag_v2_permission_sets(set_id),
    PRIMARY KEY(role_id,set_id)
);
CREATE INDEX supertag_v2_role_permission_set_reference ON supertag_v2_role_permission_sets(set_id);
CREATE TABLE supertag_v2_role_context_sets (
    role_id TEXT NOT NULL REFERENCES supertag_v2_roles(role_id),
    set_id TEXT NOT NULL REFERENCES supertag_v2_context_sets(set_id),
    PRIMARY KEY(role_id,set_id)
);
CREATE INDEX supertag_v2_role_context_set_reference ON supertag_v2_role_context_sets(set_id);
CREATE TABLE supertag_v2_role_assignments (
    assignment_id TEXT PRIMARY KEY,
    role_id TEXT NOT NULL REFERENCES supertag_v2_roles(role_id),
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    status BIGINT NOT NULL CHECK (status IN (1,2)),
    revision BIGINT NOT NULL CHECK (revision > 0),
    UNIQUE(role_id,tag_id)
);
CREATE INDEX supertag_v2_tag_role_assignments ON supertag_v2_role_assignments(tag_id,status);
CREATE TABLE supertag_v2_policy_operations (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response BLOB NOT NULL,
    PRIMARY KEY(principal,operation_id)
);
CREATE TABLE supertag_v2_policy_revisions (
    kind TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    PRIMARY KEY(kind,resource_id)
);
ALTER TABLE supertag_v2_tasks ADD COLUMN policy_snapshot BLOB NOT NULL DEFAULT X'';
ALTER TABLE supertag_v2_tasks ADD COLUMN policy_effective_digest TEXT NOT NULL DEFAULT '';
UPDATE supertag_v2_schema SET version=23 WHERE version=22;
