-- Extend each stored harness discriminator while preserving data and defaults.
ALTER TABLE supertag_v2_tags DROP CONSTRAINT supertag_v2_tags_harness_kind_check;
ALTER TABLE supertag_v2_tags ADD CHECK (harness_kind BETWEEN 0 AND 4);
ALTER TABLE supertag_v2_tasks DROP CONSTRAINT supertag_v2_tasks_harness_kind_check;
ALTER TABLE supertag_v2_tasks ADD CHECK (harness_kind BETWEEN 0 AND 4);
ALTER TABLE supertag_v2_claims DROP CONSTRAINT supertag_v2_claims_harness_kind_check;
ALTER TABLE supertag_v2_claims ADD CHECK (harness_kind BETWEEN 0 AND 4);
ALTER TABLE supertag_v2_host_readiness DROP CONSTRAINT supertag_v2_host_readiness_harness_kind_check;
ALTER TABLE supertag_v2_host_readiness ADD CHECK (harness_kind BETWEEN 0 AND 4);
UPDATE supertag_v2_schema SET version=33 WHERE version=32;
