ALTER TABLE supertag_v2_replies ADD COLUMN lease_expires_at_ms BIGINT;
ALTER TABLE supertag_v2_replies ADD COLUMN expired_claim BIGINT NOT NULL DEFAULT 0;
UPDATE supertag_v2_replies SET lease_expires_at_ms = 0 WHERE state = 2;
CREATE INDEX supertag_v2_replies_expiry ON supertag_v2_replies(state, lease_expires_at_ms);
CREATE TABLE supertag_v2_reply_audit (
  recorded_order BIGINT PRIMARY KEY,
  reply_id TEXT NOT NULL REFERENCES supertag_v2_replies(reply_id),
  kind TEXT NOT NULL,
  principal TEXT NOT NULL,
  evidence TEXT NOT NULL,
  recorded_at_ms BIGINT NOT NULL,
  state BIGINT NOT NULL,
  provider_receipt TEXT
);
CREATE INDEX supertag_v2_reply_audit_reply ON supertag_v2_reply_audit(reply_id, recorded_order);
CREATE TABLE supertag_v2_reply_resolutions (
  principal TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_digest BYTEA NOT NULL,
  response BYTEA NOT NULL,
  PRIMARY KEY(principal, operation_id)
);
UPDATE supertag_v2_schema SET version = 38 WHERE version = 37;
