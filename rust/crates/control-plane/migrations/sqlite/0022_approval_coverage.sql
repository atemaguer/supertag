-- A covered request keeps its original arguments and source. Its authority is
-- attributed to this immutable Objective-wide decision, not a second decision.
CREATE TABLE supertag_v2_approval_coverage (
    approval_id TEXT PRIMARY KEY REFERENCES supertag_v2_approvals(approval_id),
    grant_approval_id TEXT NOT NULL REFERENCES supertag_v2_approvals(approval_id),
    covered_at_ms BIGINT NOT NULL,
    CHECK (approval_id <> grant_approval_id)
);
CREATE INDEX supertag_v2_approval_coverage_grant ON supertag_v2_approval_coverage(grant_approval_id);
UPDATE supertag_v2_schema SET version=22 WHERE version=21;
