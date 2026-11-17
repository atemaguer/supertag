-- The watch feed announces a Tag's notes (WatchKind 8): kept (a turn's note taking effect, or
-- an operator's change), rewritten, and deleted. A note one turn only staged is not announced
-- until the turn succeeds. A private note is its person's; a shared one, the Tag's.
ALTER TABLE supertag_v2_watch_notices DROP CONSTRAINT supertag_v2_watch_notices_kind_check;
ALTER TABLE supertag_v2_watch_notices ADD CONSTRAINT supertag_v2_watch_notices_kind_check
    CHECK (kind BETWEEN 1 AND 8);

CREATE FUNCTION supertag_v2_watch_memory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    item supertag_v2_tag_memories%ROWTYPE;
    reason BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.state = 1 THEN RETURN NULL; END IF;
        item := OLD;
        reason := 3;
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW.state = 1 THEN RETURN NULL; END IF;
        item := NEW;
        reason := 1;
    ELSE
        IF NEW.state = OLD.state AND NEW.text = OLD.text THEN RETURN NULL; END IF;
        item := NEW;
        reason := CASE WHEN OLD.state = 1 THEN 1 ELSE 2 END;
    END IF;
    INSERT INTO supertag_v2_watch_append
        SELECT 8, reason, item.memory_id, item.tag_id, '', '', '', '', COALESCE(item.audience_principal, '');
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_memory AFTER INSERT OR UPDATE OR DELETE ON supertag_v2_tag_memories
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_memory();

-- When a turn last had the note in its context.
ALTER TABLE supertag_v2_tag_memories ADD COLUMN last_seen_at_ms BIGINT;

UPDATE supertag_v2_schema SET version=93 WHERE version=92;
