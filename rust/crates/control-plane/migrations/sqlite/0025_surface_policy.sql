CREATE TABLE supertag_v2_surface_accounts (
    account_id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL UNIQUE,
    revision BIGINT NOT NULL CHECK (revision > 0),
    payload BLOB NOT NULL
);
-- Retain transport alias ownership after a location is deleted. Its existing
-- outbox and exact ingress receipts still use the same account alias.
CREATE TABLE supertag_v2_managed_connector_aliases (
    connector_account_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES supertag_v2_surface_accounts(account_id),
    scope_key TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id)
);
CREATE TABLE supertag_v2_surface_locations (
    location_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES supertag_v2_surface_accounts(account_id),
    connector_account_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_managed_connector_aliases(connector_account_id),
    scope_key TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    payload BLOB NOT NULL,
    UNIQUE (account_id, scope_key)
);
CREATE INDEX supertag_v2_surface_location_account ON supertag_v2_surface_locations(account_id, location_id);
CREATE TABLE supertag_v2_surface_location_permission_sets (
    location_id TEXT NOT NULL REFERENCES supertag_v2_surface_locations(location_id) ON DELETE CASCADE,
    set_id TEXT NOT NULL REFERENCES supertag_v2_permission_sets(set_id) ON DELETE RESTRICT,
    PRIMARY KEY (location_id, set_id)
);
CREATE INDEX supertag_v2_surface_location_permission_set ON supertag_v2_surface_location_permission_sets(set_id);
CREATE TABLE supertag_v2_surface_location_context_sets (
    location_id TEXT NOT NULL REFERENCES supertag_v2_surface_locations(location_id) ON DELETE CASCADE,
    set_id TEXT NOT NULL REFERENCES supertag_v2_context_sets(set_id) ON DELETE RESTRICT,
    PRIMARY KEY (location_id, set_id)
);
CREATE INDEX supertag_v2_surface_location_context_set ON supertag_v2_surface_location_context_sets(set_id);
UPDATE supertag_v2_schema SET version=25 WHERE version=24;
