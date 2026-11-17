-- Slack and Lark event-ID receipts expire after 7 days. They only stop a redelivered event from
-- being admitted twice, and both providers stop redelivering within hours. The message receipts,
-- which map messages to Tasks, are kept. A receipt from before this column counts from the upgrade,
-- so an upgrade never drops them all while a provider may still be retrying.
ALTER TABLE supertag_v2_slack_events ADD COLUMN received_at_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE supertag_v2_lark_events ADD COLUMN received_at_ms BIGINT NOT NULL DEFAULT 0;
UPDATE supertag_v2_slack_events SET received_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
UPDATE supertag_v2_lark_events SET received_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
CREATE INDEX supertag_v2_slack_events_received ON supertag_v2_slack_events (received_at_ms);
CREATE INDEX supertag_v2_lark_events_received ON supertag_v2_lark_events (received_at_ms);

UPDATE supertag_v2_schema SET version=91 WHERE version=90;
