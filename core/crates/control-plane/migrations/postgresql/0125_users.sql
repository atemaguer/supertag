-- Users: the people admitted to the Control Plane. A User is a person, never a machine. Every
-- client device belongs to one; a Worker Host enrolled with a User's invite key belongs to them.
-- A User's devices act for the User, as `user:NAME`: their conversations, Objectives and the work
-- those start are the User's, on every device. Client Auth Keys go: a person's devices join with
-- the User's invite key, an Auth Key that names its User.

CREATE TABLE supertag_v2_users (
    name TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    allowed_tag_ids TEXT NOT NULL DEFAULT '[]',
    created_at_ms BIGINT NOT NULL,
    created_by TEXT NOT NULL
);
ALTER TABLE supertag_v2_auth_keys ADD COLUMN user_name TEXT REFERENCES supertag_v2_users(name);
ALTER TABLE supertag_v2_enrollments ADD COLUMN user_name TEXT REFERENCES supertag_v2_users(name);

-- A User's Objectives and their Tasks are the User's, as a client's were.
CREATE OR REPLACE VIEW supertag_v2_task_audience AS
SELECT t.task_id, t.tag_id, t.session_id, COALESCE(o.objective_id, ws.objective_id, '') AS objective_id,
       '' AS conversation,
       COALESCE(c.principal, parent.principal,
                CASE WHEN substr(obj.created_by, 1, 5) = 'user:' OR substr(obj.created_by, 1, 7) = 'client:' THEN obj.created_by END,
                NULLIF(mr.audience_principal, ''), '') AS owner
FROM supertag_v2_tasks t
LEFT JOIN supertag_v2_messages m ON m.task_id = t.task_id
LEFT JOIN supertag_v2_conversation_sessions c ON c.session_id = t.session_id AND c.tag_id = t.tag_id
LEFT JOIN supertag_v2_work_session_tasks wt ON wt.task_id = t.task_id
LEFT JOIN supertag_v2_work_sessions ws ON ws.work_session_id = wt.work_session_id
LEFT JOIN supertag_v2_conversation_sessions parent ON parent.session_id = ws.parent_session_id
    AND parent.tag_id = ws.parent_tag_id
LEFT JOIN supertag_v2_objective_tasks o ON o.task_id = t.task_id
LEFT JOIN supertag_v2_objectives obj ON obj.objective_id = COALESCE(o.objective_id, ws.objective_id)
LEFT JOIN supertag_v2_memory_reviews mr ON mr.tag_id = t.tag_id AND mr.session_id = t.session_id
WHERE (substr(t.session_id, 1, 5) <> 'work/'
       OR (wt.kind = 1 AND ws.work_session_id = t.session_id AND ws.tag_id = t.tag_id
           AND (substr(ws.parent_session_id, 1, 13) <> 'conversation/' OR parent.session_id IS NOT NULL)))
  AND (substr(t.session_id, 1, 13) <> 'conversation/'
       OR (c.session_id IS NOT NULL AND (m.task_id IS NOT NULL
           OR (wt.kind = 2 AND ws.parent_session_id = t.session_id AND ws.parent_tag_id = t.tag_id))));

CREATE OR REPLACE FUNCTION supertag_v2_watch_objective_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 4, 1, NEW.objective_id, NEW.owner_tag_id, '', NEW.objective_id, '', '',
               CASE WHEN substr(NEW.created_by, 1, 5) = 'user:' OR substr(NEW.created_by, 1, 7) = 'client:' THEN NEW.created_by ELSE '' END;
    RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION supertag_v2_watch_objective_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 4, 2, NEW.objective_id, NEW.owner_tag_id, '', NEW.objective_id, '', '',
               CASE WHEN substr(NEW.created_by, 1, 5) = 'user:' OR substr(NEW.created_by, 1, 7) = 'client:' THEN NEW.created_by ELSE '' END;
    RETURN NULL;
END;
$$;

UPDATE supertag_v2_schema SET version=125 WHERE version=124;
