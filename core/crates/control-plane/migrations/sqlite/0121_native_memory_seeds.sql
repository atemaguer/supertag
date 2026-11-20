-- A Tag's memory becomes its harness's own. The notes Tags kept with `remember` and `forget` are
-- kept once more as seeds, by Tag and audience ('' for shared): the next turn on the Tag's own
-- harness whose changes are kept writes them into that audience's store as the harness's own
-- memory, acknowledges them, and the seeds go. A note only staged by a turn that never finished
-- had not taken effect and is dropped; one a running turn was forgetting was still a note.
CREATE TABLE supertag_v2_native_memory_seeds (
    seed_id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    audience_principal TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at_ms BIGINT NOT NULL
);
CREATE INDEX supertag_v2_native_memory_seeds_tag
    ON supertag_v2_native_memory_seeds (tag_id, audience_principal);
-- A retired Tag runs no more turns, so its notes go with the table; so would a note whose Tag
-- is gone, which the foreign key should have prevented.
INSERT INTO supertag_v2_native_memory_seeds (seed_id, tag_id, audience_principal, text, created_at_ms)
    SELECT m.memory_id, m.tag_id, COALESCE(m.audience_principal, ''), m.text, m.created_at_ms
    FROM supertag_v2_tag_memories m
    JOIN supertag_v2_tags t ON t.tag_id = m.tag_id AND t.retired_at_ms IS NULL
    WHERE m.state IN (2, 3);

-- Notes, their replay receipts, and their watch notices (WatchKind 8) go.
DROP TRIGGER IF EXISTS supertag_v2_watch_memory_kept;
DROP TRIGGER IF EXISTS supertag_v2_watch_memory_changed;
DROP TRIGGER IF EXISTS supertag_v2_watch_memory_deleted;
DELETE FROM supertag_v2_watch_notices WHERE kind = 8;
DROP TABLE supertag_v2_memory_receipts;
DROP TABLE supertag_v2_tag_memories;

UPDATE supertag_v2_schema SET version=121 WHERE version=120;
