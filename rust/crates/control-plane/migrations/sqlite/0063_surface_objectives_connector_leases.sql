-- One fenced Gateway owns a connector account's outbound delivery at a time.
CREATE TABLE supertag_v2_connector_leases (
    account_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    fence BIGINT NOT NULL,
    expires_at_ms BIGINT NOT NULL
);
-- A surface thread that started an Objective is that Objective's home thread.
CREATE TABLE supertag_v2_surface_objectives (
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    objective_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_objectives(objective_id),
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    started_by_event_id TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id, thread_id)
);
UPDATE supertag_v2_schema SET version=63 WHERE version=56;
