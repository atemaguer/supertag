-- A Tag's memory: short notes it keeps of what it cannot look up again. `audience_principal` is
-- NULL for a shared note, or the principal whose conversation wrote a private note. States: 1
-- staged (its turn has not finished), 2 active, 3 forgetting (a running turn forgot or replaced
-- it). `origin_attempt_id` is the turn that staged the row or its forgetting; `replaces` names
-- the note a staged note replaces.
CREATE TABLE supertag_v2_tag_memories (
    memory_id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    audience_principal TEXT,
    text TEXT NOT NULL,
    state SMALLINT NOT NULL CHECK (state BETWEEN 1 AND 3),
    created_by TEXT NOT NULL,
    source_task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    origin_attempt_id TEXT,
    replaces TEXT,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL
);
CREATE INDEX supertag_v2_tag_memories_tag ON supertag_v2_tag_memories (tag_id, state);
CREATE INDEX supertag_v2_tag_memories_origin ON supertag_v2_tag_memories (origin_attempt_id);

-- Exact replay of a `remember` or `forget` call by its operation ID, per Task.
CREATE TABLE supertag_v2_memory_receipts (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    PRIMARY KEY (principal, operation_id)
);

-- Whether the Tag keeps memory, when it last reviewed its work, and the review turn it queued.
ALTER TABLE supertag_v2_tags ADD COLUMN memory SMALLINT NOT NULL DEFAULT 1 CHECK (memory IN (0, 1));
ALTER TABLE supertag_v2_tags ADD COLUMN memory_reviewed_at_ms BIGINT;
ALTER TABLE supertag_v2_tags ADD COLUMN memory_review_task_id TEXT;

UPDATE supertag_v2_schema SET version=88 WHERE version=87;
