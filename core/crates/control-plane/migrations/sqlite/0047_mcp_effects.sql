CREATE TABLE supertag_v2_mcp_effects (
    attempt_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    approval_id TEXT NOT NULL REFERENCES supertag_v2_approvals(approval_id),
    effect_digest TEXT NOT NULL,
    uncertainty_digest TEXT NOT NULL,
    dispatch_id TEXT NOT NULL UNIQUE,
    state BIGINT NOT NULL CHECK (state IN (1,2,3)),
    result_json TEXT,
    reserved_at_ms BIGINT NOT NULL,
    settled_at_ms BIGINT,
    PRIMARY KEY (attempt_id,operation_id),
    CHECK ((state = 1 AND settled_at_ms IS NULL AND result_json IS NULL)
        OR (state = 2 AND settled_at_ms IS NOT NULL AND result_json IS NOT NULL)
        OR (state = 3 AND settled_at_ms IS NOT NULL AND result_json IS NULL))
);
CREATE INDEX supertag_v2_mcp_effects_unconfirmed
    ON supertag_v2_mcp_effects(uncertainty_digest) WHERE state IN (1,3);
UPDATE supertag_v2_schema SET version=47 WHERE version=46;
