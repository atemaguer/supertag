-- Operator Tokens store only the SHA-256 digest of the current secret. Names are never reused.
CREATE TABLE supertag_v2_operator_tokens (
    name TEXT PRIMARY KEY,
    secret_digest TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL,
    secret_revision BIGINT NOT NULL CHECK (secret_revision > 0),
    created_by TEXT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    expires_at_ms BIGINT NOT NULL,
    rotated_at_ms BIGINT,
    last_used_at_ms BIGINT,
    revoked_at_ms BIGINT
);

-- Every secret digest a token has held and the operation that set it. A digest is never accepted
-- again, so a late retry of a superseded rotation cannot restore its secret.
CREATE TABLE supertag_v2_operator_token_secrets (
    secret_digest TEXT PRIMARY KEY,
    name TEXT NOT NULL REFERENCES supertag_v2_operator_tokens(name),
    operation_id TEXT NOT NULL,
    secret_revision BIGINT NOT NULL,
    UNIQUE (name, operation_id)
);

-- Administrative and authority-changing operator calls, in the Control Plane write order.
CREATE TABLE supertag_v2_audit_entries (
    sequence BIGINT PRIMARY KEY,
    entry_id TEXT NOT NULL UNIQUE,
    at_ms BIGINT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    outcome BIGINT NOT NULL CHECK (outcome IN (1, 2)),
    code TEXT NOT NULL,
    method TEXT NOT NULL
);
CREATE INDEX supertag_v2_audit_entries_actor ON supertag_v2_audit_entries(actor, sequence);

UPDATE supertag_v2_schema SET version=61 WHERE version=56;
