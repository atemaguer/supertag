-- Durable outbox of operator notifications: Inbox items told to a Gateway's configured
-- destinations, at most one message per Objective per destination per window. Each operator
-- has its own outbox: only a Gateway acting for that operator records, claims, or settles it.
CREATE TABLE supertag_v2_operator_notifications (
    notification_id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    destination_key TEXT NOT NULL,
    provider BIGINT NOT NULL,
    -- '*' for a message not batched per Objective.
    objective_id TEXT NOT NULL,
    item_keys TEXT NOT NULL,
    text TEXT NOT NULL,
    more BIGINT NOT NULL CHECK (more IN (0,1)),
    immediate BIGINT NOT NULL CHECK (immediate IN (0,1)),
    -- 1 pending, 2 delivering, 3 delivered, 4 failed.
    status BIGINT NOT NULL CHECK (status BETWEEN 1 AND 4),
    attempt_count BIGINT NOT NULL DEFAULT 0,
    max_attempts BIGINT NOT NULL CHECK (max_attempts >= 1),
    available_at_ms BIGINT NOT NULL,
    lease_token TEXT,
    lease_expires_at_ms BIGINT,
    last_error TEXT,
    external_message_id TEXT,
    delivered_at_ms BIGINT,
    failed_at_ms BIGINT,
    created_at_ms BIGINT NOT NULL,
    created_order BIGINT NOT NULL UNIQUE
);
CREATE INDEX supertag_v2_operator_notifications_due ON supertag_v2_operator_notifications(principal, status, available_at_ms, created_order);
CREATE INDEX supertag_v2_operator_notifications_window ON supertag_v2_operator_notifications(principal, destination_key, objective_id, created_at_ms);
-- Each Inbox item occurrence reaches one operator's destination at most once.
CREATE TABLE supertag_v2_operator_notification_items (
    principal TEXT NOT NULL,
    destination_key TEXT NOT NULL,
    item_key TEXT NOT NULL,
    notification_id TEXT NOT NULL REFERENCES supertag_v2_operator_notifications(notification_id),
    PRIMARY KEY (principal, destination_key, item_key)
);
CREATE INDEX supertag_v2_operator_notification_items_message ON supertag_v2_operator_notification_items(notification_id);
UPDATE supertag_v2_schema SET version=65 WHERE version=64;
