-- The watch feed announces a Tag's notes (WatchKind 8): kept (a turn's note taking effect, or
-- an operator's change), rewritten, and deleted. A note one turn only staged is not announced
-- until the turn succeeds. A private note is its person's; a shared one, the Tag's.
-- SQLite cannot change a CHECK, so the table is rebuilt. The legacy rename keeps the append view
-- and the triggers that write through it as they are.
PRAGMA legacy_alter_table = ON;
CREATE TABLE supertag_v2_watch_notices_next (
    position BIGINT PRIMARY KEY CHECK (position > 0),
    kind BIGINT NOT NULL CHECK (kind BETWEEN 1 AND 8),
    reason BIGINT NOT NULL CHECK (reason BETWEEN 1 AND 3),
    resource_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    objective_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    conversation TEXT NOT NULL,
    owner TEXT NOT NULL,
    changed_at_ms BIGINT NOT NULL
);
INSERT INTO supertag_v2_watch_notices_next SELECT * FROM supertag_v2_watch_notices;
DROP TABLE supertag_v2_watch_notices;
ALTER TABLE supertag_v2_watch_notices_next RENAME TO supertag_v2_watch_notices;
PRAGMA legacy_alter_table = OFF;

CREATE TRIGGER supertag_v2_watch_memory_kept AFTER INSERT ON supertag_v2_tag_memories
WHEN NEW.state <> 1
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 8, 1, NEW.memory_id, NEW.tag_id, '', '', '', '', COALESCE(NEW.audience_principal, '');
END;

CREATE TRIGGER supertag_v2_watch_memory_changed AFTER UPDATE ON supertag_v2_tag_memories
WHEN NEW.state <> OLD.state OR NEW.text <> OLD.text
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 8, CASE WHEN OLD.state = 1 THEN 1 ELSE 2 END, NEW.memory_id, NEW.tag_id, '', '',
               '', '', COALESCE(NEW.audience_principal, '');
END;

CREATE TRIGGER supertag_v2_watch_memory_deleted AFTER DELETE ON supertag_v2_tag_memories
WHEN OLD.state <> 1
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 8, 3, OLD.memory_id, OLD.tag_id, '', '', '', '', COALESCE(OLD.audience_principal, '');
END;

-- When a turn last had the note in its context.
ALTER TABLE supertag_v2_tag_memories ADD COLUMN last_seen_at_ms BIGINT;

UPDATE supertag_v2_schema SET version=93 WHERE version=92;
