ALTER TABLE supertag_v2_host_readiness ADD COLUMN disk_free_bytes BIGINT;
ALTER TABLE supertag_v2_host_readiness ADD COLUMN disk_total_bytes BIGINT;
UPDATE supertag_v2_schema SET version=57 WHERE version=56;
