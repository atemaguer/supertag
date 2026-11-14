-- Extend the stored harness enum without rebuilding Tasks or their relations.
-- Updating only this value leaves the state-sensitive Watch triggers unchanged.
ALTER TABLE supertag_v2_tags ADD COLUMN next_harness_kind BIGINT NOT NULL DEFAULT 0 CHECK (next_harness_kind BETWEEN 0 AND 4);
UPDATE supertag_v2_tags SET next_harness_kind=harness_kind;
ALTER TABLE supertag_v2_tags DROP COLUMN harness_kind;
ALTER TABLE supertag_v2_tags RENAME COLUMN next_harness_kind TO harness_kind;
ALTER TABLE supertag_v2_tasks ADD COLUMN next_harness_kind BIGINT NOT NULL DEFAULT 0 CHECK (next_harness_kind BETWEEN 0 AND 4);
UPDATE supertag_v2_tasks SET next_harness_kind=harness_kind;
ALTER TABLE supertag_v2_tasks DROP COLUMN harness_kind;
ALTER TABLE supertag_v2_tasks RENAME COLUMN next_harness_kind TO harness_kind;
ALTER TABLE supertag_v2_claims ADD COLUMN next_harness_kind BIGINT NOT NULL DEFAULT 0 CHECK (next_harness_kind BETWEEN 0 AND 4);
UPDATE supertag_v2_claims SET next_harness_kind=harness_kind;
ALTER TABLE supertag_v2_claims DROP COLUMN harness_kind;
ALTER TABLE supertag_v2_claims RENAME COLUMN next_harness_kind TO harness_kind;
ALTER TABLE supertag_v2_host_readiness ADD COLUMN next_harness_kind BIGINT NOT NULL DEFAULT 0 CHECK (next_harness_kind BETWEEN 0 AND 4);
UPDATE supertag_v2_host_readiness SET next_harness_kind=harness_kind;
ALTER TABLE supertag_v2_host_readiness DROP COLUMN harness_kind;
ALTER TABLE supertag_v2_host_readiness RENAME COLUMN next_harness_kind TO harness_kind;
UPDATE supertag_v2_schema SET version=33 WHERE version=32;
