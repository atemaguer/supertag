ALTER TABLE supertag_v2_tags ADD COLUMN harness_kind BIGINT NOT NULL DEFAULT 0
    CHECK (harness_kind BETWEEN 0 AND 3);
ALTER TABLE supertag_v2_tasks ADD COLUMN harness_kind BIGINT NOT NULL DEFAULT 0
    CHECK (harness_kind BETWEEN 0 AND 3);
ALTER TABLE supertag_v2_claims ADD COLUMN harness_kind BIGINT NOT NULL DEFAULT 0
    CHECK (harness_kind BETWEEN 0 AND 3);

UPDATE supertag_v2_schema SET version = 11 WHERE version = 10;
