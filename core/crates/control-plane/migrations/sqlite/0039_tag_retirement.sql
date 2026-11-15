ALTER TABLE supertag_v2_tags ADD COLUMN name TEXT;
ALTER TABLE supertag_v2_tags ADD COLUMN retired_at_ms BIGINT;
CREATE UNIQUE INDEX supertag_v2_tags_active_name
    ON supertag_v2_tags(COALESCE(name, tag_id)) WHERE retired_at_ms IS NULL;
UPDATE supertag_v2_schema SET version=39 WHERE version=38;
