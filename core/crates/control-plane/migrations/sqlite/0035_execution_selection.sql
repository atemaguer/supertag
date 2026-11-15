ALTER TABLE supertag_v2_tasks ADD COLUMN attempt_execution BLOB;
ALTER TABLE supertag_v2_claims ADD COLUMN execution_profile BLOB;
ALTER TABLE supertag_v2_claims ADD COLUMN attempt_execution BLOB;
ALTER TABLE supertag_v2_host_readiness ADD COLUMN execution_profile BLOB;
UPDATE supertag_v2_schema SET version=35 WHERE version=34;
