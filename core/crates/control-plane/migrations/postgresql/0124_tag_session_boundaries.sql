-- Only a Tag's inbox Session reaches other Tags. An Objective names no Team: its Session asks its
-- own Tag's inbox Session instead of delegating work to another Tag or posting to a Workstream.
-- A Work Session delegated to another Tag before this upgrade keeps running and still reports to
-- its Objective; nothing new can start one.

-- 1. The Objective's Team goes, with its index and the watch trigger that compared it.
DROP TRIGGER supertag_v2_watch_objective_changed ON supertag_v2_objectives;
DROP INDEX supertag_v2_objectives_team;
ALTER TABLE supertag_v2_objectives DROP COLUMN team_id;
CREATE TRIGGER supertag_v2_watch_objective_changed AFTER UPDATE ON supertag_v2_objectives
FOR EACH ROW WHEN (NEW.revision <> OLD.revision OR NEW.status <> OLD.status
    OR NEW.limit_state <> OLD.limit_state) EXECUTE FUNCTION supertag_v2_watch_objective_changed();

-- 2. A Team's concurrency limit counted the Tasks of the Objectives that named it; nothing is
-- left for it to count.
ALTER TABLE supertag_v2_teams DROP COLUMN max_concurrency;

-- 3. An Objective's turn asks its Tag (`ask_tag`). The ask is a message in the Objective's
-- conversation with its Tag: a direct conversation keyed `o:<objective>` whose one member is the
-- Tag, and which wakes the Tag's inbox Session like a Tag's message. The inbox Session's answer is
-- a later message there and becomes the Objective's next turn. An ask is due until it is answered.
CREATE TABLE supertag_v2_objective_asks (
    message_id TEXT PRIMARY KEY REFERENCES supertag_v2_messages(message_id),
    objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    asked_at_ms BIGINT NOT NULL,
    answer_message_id TEXT REFERENCES supertag_v2_messages(message_id),
    answer_task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    answered_at_ms BIGINT,
    CHECK ((answer_message_id IS NULL) = (answered_at_ms IS NULL))
);
CREATE INDEX supertag_v2_objective_asks_open
    ON supertag_v2_objective_asks(objective_id) WHERE answered_at_ms IS NULL;

UPDATE supertag_v2_schema SET version=124 WHERE version=123;
