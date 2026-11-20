-- A Tag's portrait: a recipe of components from an art catalog the clients bundle, as JSON, and
-- the revision of its own writes. NULL is the default portrait clients derive from the Tag ID.
-- Tag writes leave both alone, and an appearance write leaves the Tag's revision alone.
ALTER TABLE supertag_v2_tags ADD COLUMN appearance TEXT;
ALTER TABLE supertag_v2_tags ADD COLUMN appearance_revision BIGINT NOT NULL DEFAULT 0;

-- An appearance write is a Tag change on the watch, like any other.
CREATE TRIGGER supertag_v2_watch_tag_appearance_changed AFTER UPDATE ON supertag_v2_tags
FOR EACH ROW WHEN (NEW.appearance_revision <> OLD.appearance_revision)
EXECUTE FUNCTION supertag_v2_watch_tag_changed();

UPDATE supertag_v2_schema SET version=125 WHERE version=124;
