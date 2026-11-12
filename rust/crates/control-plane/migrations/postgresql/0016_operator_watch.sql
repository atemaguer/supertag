CREATE TABLE supertag_v2_watch_state (
    singleton BIGINT PRIMARY KEY CHECK (singleton = 1),
    feed_id TEXT NOT NULL,
    head BIGINT NOT NULL CHECK (head >= 0),
    floor BIGINT NOT NULL CHECK (floor >= 0 AND floor <= head)
);
INSERT INTO supertag_v2_watch_state VALUES (1, '', 0, 0);

CREATE TABLE supertag_v2_watch_notices (
    position BIGINT PRIMARY KEY CHECK (position > 0),
    kind BIGINT NOT NULL CHECK (kind BETWEEN 1 AND 6),
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

-- A personal Task becomes observable only after its durable owner is recorded.
CREATE VIEW supertag_v2_watch_tasks AS
SELECT t.task_id, t.tag_id, t.session_id, COALESCE(o.objective_id, '') AS objective_id,
       COALESCE(c.name, '') AS conversation, COALESCE(m.principal, '') AS owner
FROM supertag_v2_tasks t
LEFT JOIN supertag_v2_conversation_messages m ON m.task_id = t.task_id
LEFT JOIN supertag_v2_conversations c ON c.session_id = m.session_id
LEFT JOIN supertag_v2_objective_tasks o ON o.task_id = t.task_id
WHERE substr(t.session_id, 1, 13) <> 'conversation/' OR m.task_id IS NOT NULL;

-- Append inside the triggering write. Locking one head row serializes positions
-- in commit order even when writers affect unrelated resources.
CREATE VIEW supertag_v2_watch_append AS
SELECT kind, reason, resource_id, tag_id, session_id, objective_id, team_id, conversation, owner
FROM supertag_v2_watch_notices WHERE 1 = 0;

CREATE FUNCTION supertag_v2_watch_append_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE supertag_v2_watch_state SET head = head + 1 WHERE singleton = 1;
    INSERT INTO supertag_v2_watch_notices
    SELECT head, NEW.kind, NEW.reason, NEW.resource_id, NEW.tag_id, NEW.session_id,
           NEW.objective_id, NEW.team_id, NEW.conversation, NEW.owner, CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)
    FROM supertag_v2_watch_state WHERE singleton = 1;
    RETURN NEW;
END;
$$;
CREATE TRIGGER supertag_v2_watch_append_notice INSTEAD OF INSERT ON supertag_v2_watch_append
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_append_notice();

CREATE FUNCTION supertag_v2_watch_tag_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 1, 1, NEW.tag_id, NEW.tag_id, '', '', '', '', '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_tag_created AFTER INSERT ON supertag_v2_tags
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_tag_created();

CREATE FUNCTION supertag_v2_watch_tag_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 1, 2, NEW.tag_id, NEW.tag_id, '', '', '', '', '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_tag_changed AFTER UPDATE ON supertag_v2_tags
FOR EACH ROW WHEN (NEW.revision <> OLD.revision) EXECUTE FUNCTION supertag_v2_watch_tag_changed();

CREATE FUNCTION supertag_v2_watch_tag_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 1, 3, OLD.tag_id, OLD.tag_id, '', '', '', '', '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_tag_deleted AFTER DELETE ON supertag_v2_tags
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_tag_deleted();

CREATE FUNCTION supertag_v2_watch_task_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 2, 1, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks WHERE task_id = NEW.task_id;
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_task_created AFTER INSERT ON supertag_v2_tasks
FOR EACH ROW WHEN (substr(NEW.session_id, 1, 13) <> 'conversation/') EXECUTE FUNCTION supertag_v2_watch_task_created();

CREATE FUNCTION supertag_v2_watch_task_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 2, 2, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks WHERE task_id = NEW.task_id;
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_task_changed AFTER UPDATE ON supertag_v2_tasks
FOR EACH ROW WHEN (NEW.state <> OLD.state OR NEW.result IS DISTINCT FROM OLD.result
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.next_sequence <> OLD.next_sequence) EXECUTE FUNCTION supertag_v2_watch_task_changed();

CREATE FUNCTION supertag_v2_watch_objective_task_linked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 2, 2, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks WHERE task_id = NEW.task_id;
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_objective_task_linked AFTER INSERT ON supertag_v2_objective_tasks
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_objective_task_linked();

CREATE FUNCTION supertag_v2_watch_conversation_message_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 2, 1, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks WHERE task_id = NEW.task_id;
    INSERT INTO supertag_v2_watch_append
        SELECT 3, 1, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks WHERE task_id = NEW.task_id;
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_conversation_message_created AFTER INSERT ON supertag_v2_conversation_messages
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_conversation_message_created();

CREATE FUNCTION supertag_v2_watch_live_input_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 3, 2, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks WHERE task_id = NEW.follower_task_id AND owner <> '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_live_input_changed AFTER UPDATE ON supertag_v2_live_inputs
FOR EACH ROW WHEN (NEW.state <> OLD.state) EXECUTE FUNCTION supertag_v2_watch_live_input_changed();

CREATE FUNCTION supertag_v2_watch_objective_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 4, 1, NEW.objective_id, NEW.owner_tag_id, '', NEW.objective_id, '', '', '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_objective_created AFTER INSERT ON supertag_v2_objectives
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_objective_created();

CREATE FUNCTION supertag_v2_watch_objective_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 4, 2, NEW.objective_id, NEW.owner_tag_id, '', NEW.objective_id, '', '', '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_objective_changed AFTER UPDATE ON supertag_v2_objectives
FOR EACH ROW WHEN (NEW.revision <> OLD.revision OR NEW.status <> OLD.status
    OR NEW.limit_state <> OLD.limit_state OR NEW.team_id IS DISTINCT FROM OLD.team_id) EXECUTE FUNCTION supertag_v2_watch_objective_changed();

CREATE FUNCTION supertag_v2_watch_team_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 5, 1, NEW.team_id, '', '', '', NEW.team_id, '', '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_team_created AFTER INSERT ON supertag_v2_teams
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_team_created();

CREATE FUNCTION supertag_v2_watch_team_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 5, 2, NEW.team_id, '', '', '', NEW.team_id, '', '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_team_changed AFTER UPDATE ON supertag_v2_teams
FOR EACH ROW WHEN (NEW.revision <> OLD.revision) EXECUTE FUNCTION supertag_v2_watch_team_changed();

CREATE FUNCTION supertag_v2_watch_team_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 5, 3, OLD.team_id, '', '', '', OLD.team_id, '', '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_team_deleted AFTER DELETE ON supertag_v2_teams
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_team_deleted();

CREATE FUNCTION supertag_v2_watch_workstream_post_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 6, 1, NEW.post_id, '', '', '', NEW.team_id, '', '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_workstream_post_created AFTER INSERT ON supertag_v2_workstream_posts
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_workstream_post_created();

UPDATE supertag_v2_schema SET version = 16 WHERE version = 15;
