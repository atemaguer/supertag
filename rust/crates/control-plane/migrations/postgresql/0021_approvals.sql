ALTER TABLE supertag_v2_tags ADD COLUMN approval_rules TEXT NOT NULL DEFAULT '[]';
ALTER TABLE supertag_v2_tasks ADD COLUMN approval_rules TEXT NOT NULL DEFAULT '[]';
ALTER TABLE supertag_v2_tasks ADD COLUMN finish_waiting_approval_ids TEXT NOT NULL DEFAULT '[]';
CREATE TABLE supertag_v2_approvals (
    approval_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    attempt_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    objective_id TEXT REFERENCES supertag_v2_objectives(objective_id),
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    canonical_arguments_json TEXT NOT NULL,
    arguments_digest TEXT NOT NULL,
    rule_digest TEXT NOT NULL,
    summary TEXT NOT NULL,
    operator_ids TEXT NOT NULL,
    state BIGINT NOT NULL CHECK (state IN (1,2,3,4)),
    scope BIGINT NOT NULL DEFAULT 0 CHECK (scope IN (0,1,2)),
    requested_at_ms BIGINT NOT NULL,
    requested_order BIGINT NOT NULL UNIQUE,
    decided_at_ms BIGINT,
    decided_by TEXT,
    reason TEXT,
    valid_until_ms BIGINT,
    consumed_at_ms BIGINT
);
CREATE INDEX supertag_v2_approvals_scope ON supertag_v2_approvals(objective_id,tag_id,action,resource,state);
CREATE INDEX supertag_v2_approvals_task ON supertag_v2_approvals(task_id,attempt_id);
CREATE TABLE supertag_v2_approval_operations (
    attempt_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    approval_id TEXT NOT NULL REFERENCES supertag_v2_approvals(approval_id),
    granted BIGINT NOT NULL DEFAULT 0 CHECK (granted IN (0,1)),
    PRIMARY KEY (attempt_id,operation_id)
);
CREATE TABLE supertag_v2_approval_decisions (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    approval_id TEXT NOT NULL REFERENCES supertag_v2_approvals(approval_id),
    PRIMARY KEY (principal,operation_id)
);
CREATE TABLE supertag_v2_approval_waits (
    task_id TEXT PRIMARY KEY REFERENCES supertag_v2_tasks(task_id),
    attempt_id TEXT NOT NULL,
    continuation_task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id)
);
CREATE TABLE supertag_v2_approval_wait_requests (
    approval_id TEXT PRIMARY KEY REFERENCES supertag_v2_approvals(approval_id),
    task_id TEXT NOT NULL REFERENCES supertag_v2_approval_waits(task_id)
);
CREATE TABLE supertag_v2_approval_sweep (
    singleton BIGINT PRIMARY KEY CHECK (singleton=1),
    request_order BIGINT NOT NULL DEFAULT 0,
    wait_order BIGINT NOT NULL DEFAULT 0
);
INSERT INTO supertag_v2_approval_sweep (singleton) VALUES (1);
UPDATE supertag_v2_schema SET version=21 WHERE version=20;
