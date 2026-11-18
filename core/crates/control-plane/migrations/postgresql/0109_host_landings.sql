-- The Worker Host holding each landing's delivery lands it. `claimed_by` is the principal whose
-- lease is current, and `pushed_commit` is a review landing's branch a host pushed, whose pull
-- request git delivery opens next.
ALTER TABLE supertag_v2_workspace_landings ADD COLUMN holder_host_id TEXT NOT NULL DEFAULT '';
ALTER TABLE supertag_v2_workspace_landings ADD COLUMN claimed_by TEXT;
ALTER TABLE supertag_v2_workspace_landings ADD COLUMN pushed_commit TEXT NOT NULL DEFAULT '';
UPDATE supertag_v2_schema SET version=109 WHERE version=108;
