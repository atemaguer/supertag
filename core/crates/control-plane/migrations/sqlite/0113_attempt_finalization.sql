-- When each Attempt's harness finished and when its Worker Host reported the result, by the
-- Control Plane's clock, for the finalization time in `supertag metrics`.
ALTER TABLE supertag_v2_claims ADD COLUMN harness_finished_at_ms BIGINT;
ALTER TABLE supertag_v2_claims ADD COLUMN reported_at_ms BIGINT;
UPDATE supertag_v2_schema SET version=113 WHERE version=112;
