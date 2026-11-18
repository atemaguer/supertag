-- When git delivery read a landed Session branch back from the remote with `ls-remote`.
ALTER TABLE supertag_v2_workspace_landings ADD COLUMN verified_at_ms BIGINT;
UPDATE supertag_v2_schema SET version=110 WHERE version=109;
