-- SQLite: Auth Keys admit one role (host, gateway or client), and every enrolled host, Gateway
-- and client presents its own credential, stored only as a digest in supertag_v2_enrollments.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE supertag_v2_auth_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'host'
    CHECK (role IN ('host', 'gateway', 'client'));

-- One row per principal an Auth Key enrolled, whatever its role. Each join keeps its own replay
-- fingerprint, so a lost response can be retried with the same operation.
CREATE TABLE supertag_v2_auth_key_joins (
    key_digest TEXT NOT NULL REFERENCES supertag_v2_auth_keys(key_digest),
    role TEXT NOT NULL CHECK (role IN ('host', 'gateway', 'client')),
    name TEXT NOT NULL,
    enrollment_digest TEXT NOT NULL,
    enrolled_at_ms BIGINT NOT NULL,
    PRIMARY KEY (key_digest, role, name)
);
INSERT INTO supertag_v2_auth_key_joins (key_digest, role, name, enrollment_digest, enrolled_at_ms)
SELECT key_digest, 'host', host_id, enrollment_digest, enrolled_at_ms
FROM supertag_v2_auth_key_enrollments;
INSERT INTO supertag_v2_auth_key_joins (key_digest, role, name, enrollment_digest, enrolled_at_ms)
SELECT key_digest, 'host', host_id, enrollment_digest, consumed_at_ms
FROM supertag_v2_auth_keys
WHERE reusable = 0 AND enrollment_digest IS NOT NULL AND consumed_at_ms IS NOT NULL;
DROP TABLE supertag_v2_auth_key_enrollments;

-- Every enrolled principal and the digest of its current credential. Names are never reused
-- within a role. auth_key_name is NULL for a credential from the Control Plane's startup
-- configuration. Client Tag limits come from the Auth Key; host Tag scope stays with the host.
CREATE TABLE supertag_v2_enrollments (
    role TEXT NOT NULL CHECK (role IN ('host', 'gateway', 'client')),
    name TEXT NOT NULL,
    token_digest TEXT NOT NULL UNIQUE,
    credential_revision BIGINT NOT NULL DEFAULT 1 CHECK (credential_revision > 0),
    auth_key_name TEXT,
    allowed_tag_ids TEXT NOT NULL DEFAULT '[]',
    all_tags BIGINT NOT NULL DEFAULT 0 CHECK (all_tags IN (0, 1)),
    enrolled_at_ms BIGINT NOT NULL,
    last_used_at_ms BIGINT,
    revoked_at_ms BIGINT,
    PRIMARY KEY (role, name)
);
INSERT INTO supertag_v2_enrollments
    (role, name, token_digest, credential_revision, auth_key_name, all_tags, enrolled_at_ms, revoked_at_ms)
SELECT 'host', h.host_id, h.token_digest, h.credential_revision,
       (SELECT k.name FROM supertag_v2_auth_key_joins j
        JOIN supertag_v2_auth_keys k ON k.key_digest = j.key_digest
        WHERE j.role = 'host' AND j.name = h.host_id),
       h.all_tags, h.enrolled_at_ms, h.revoked_at_ms
FROM supertag_v2_hosts h;

-- Every credential digest an enrollee has held. A digest is never accepted again, so a late retry
-- of a superseded rotation cannot restore its secret.
CREATE TABLE supertag_v2_enrollment_secrets (
    token_digest TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    credential_revision BIGINT NOT NULL
);
INSERT INTO supertag_v2_enrollment_secrets (token_digest, role, name, credential_revision)
SELECT token_digest, role, name, credential_revision FROM supertag_v2_enrollments;

ALTER TABLE supertag_v2_auth_keys DROP COLUMN host_id;
ALTER TABLE supertag_v2_auth_keys DROP COLUMN enrollment_digest;

-- Worker Hosts keep only execution state; their credentials moved to supertag_v2_enrollments.
-- The table is recreated under its own name, so the rows its dependents reference are inserted
-- again before the deferred foreign keys are checked at commit.
CREATE TABLE supertag_v2_hosts_saved AS
SELECT host_id, all_tags, generation, enrolled_at_ms, revoked_at_ms, draining, ephemeral, granted_labels, removed_at_ms
FROM supertag_v2_hosts;
DROP TABLE supertag_v2_hosts;
CREATE TABLE supertag_v2_hosts (
    host_id TEXT PRIMARY KEY,
    all_tags BIGINT NOT NULL CHECK (all_tags IN (0, 1)),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    enrolled_at_ms BIGINT NOT NULL,
    revoked_at_ms BIGINT,
    draining BIGINT NOT NULL DEFAULT 0 CHECK (draining IN (0, 1)),
    ephemeral BIGINT NOT NULL DEFAULT 0 CHECK (ephemeral IN (0, 1)),
    granted_labels TEXT NOT NULL DEFAULT '[]',
    removed_at_ms BIGINT
);
INSERT INTO supertag_v2_hosts
    (host_id, all_tags, generation, enrolled_at_ms, revoked_at_ms, draining, ephemeral, granted_labels, removed_at_ms)
SELECT host_id, all_tags, generation, enrolled_at_ms, revoked_at_ms, draining, ephemeral, granted_labels, removed_at_ms
FROM supertag_v2_hosts_saved;
DROP TABLE supertag_v2_hosts_saved;
CREATE INDEX supertag_v2_hosts_ephemeral ON supertag_v2_hosts(ephemeral, revoked_at_ms);

-- An unmanaged connector account (one no SurfaceAccount binds) belongs to the first Gateway that
-- acts for it, until that Gateway is revoked.
CREATE TABLE supertag_v2_connector_gateways (
    connector_account_id TEXT PRIMARY KEY,
    gateway TEXT NOT NULL,
    bound_at_ms BIGINT NOT NULL
);

-- The principal that created an Objective. A client's Objectives and their Tasks are its own.
ALTER TABLE supertag_v2_objectives ADD COLUMN created_by TEXT NOT NULL DEFAULT '';

DROP VIEW supertag_v2_watch_tasks;
DROP VIEW supertag_v2_task_audience;
CREATE VIEW supertag_v2_task_audience AS
SELECT t.task_id, t.tag_id, t.session_id, COALESCE(o.objective_id, ws.objective_id, '') AS objective_id,
       COALESCE(c.name, parent.name, '') AS conversation,
       COALESCE(c.principal, parent.principal,
                CASE WHEN substr(obj.created_by, 1, 7) = 'client:' THEN obj.created_by END, '') AS owner
FROM supertag_v2_tasks t
LEFT JOIN supertag_v2_conversation_messages m ON m.task_id = t.task_id
LEFT JOIN supertag_v2_conversations c ON c.session_id = t.session_id AND c.tag_id = t.tag_id
LEFT JOIN supertag_v2_work_session_tasks wt ON wt.task_id = t.task_id
LEFT JOIN supertag_v2_work_sessions ws ON ws.work_session_id = wt.work_session_id
LEFT JOIN supertag_v2_conversations parent ON parent.session_id = ws.parent_session_id
    AND parent.tag_id = ws.parent_tag_id
LEFT JOIN supertag_v2_objective_tasks o ON o.task_id = t.task_id
LEFT JOIN supertag_v2_objectives obj ON obj.objective_id = COALESCE(o.objective_id, ws.objective_id)
WHERE (substr(t.session_id, 1, 5) <> 'work/'
       OR (wt.kind = 1 AND ws.work_session_id = t.session_id AND ws.tag_id = t.tag_id
           AND (substr(ws.parent_session_id, 1, 13) <> 'conversation/' OR parent.session_id IS NOT NULL)))
  AND (substr(t.session_id, 1, 13) <> 'conversation/'
       OR (c.session_id IS NOT NULL AND (m.task_id IS NOT NULL
           OR (wt.kind = 2 AND ws.parent_session_id = t.session_id AND ws.parent_tag_id = t.tag_id))));
CREATE VIEW supertag_v2_watch_tasks AS
SELECT task_id, tag_id, session_id, objective_id, conversation, owner
FROM supertag_v2_task_audience;

DROP TRIGGER supertag_v2_watch_objective_created;
CREATE TRIGGER supertag_v2_watch_objective_created AFTER INSERT ON supertag_v2_objectives
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 4, 1, NEW.objective_id, NEW.owner_tag_id, '', NEW.objective_id, '', '',
               CASE WHEN substr(NEW.created_by, 1, 7) = 'client:' THEN NEW.created_by ELSE '' END;
END;
DROP TRIGGER supertag_v2_watch_objective_changed;
CREATE TRIGGER supertag_v2_watch_objective_changed AFTER UPDATE ON supertag_v2_objectives
WHEN NEW.revision <> OLD.revision OR NEW.status <> OLD.status
    OR NEW.limit_state <> OLD.limit_state OR NEW.team_id IS DISTINCT FROM OLD.team_id
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 4, 2, NEW.objective_id, NEW.owner_tag_id, '', NEW.objective_id, '', '',
               CASE WHEN substr(NEW.created_by, 1, 7) = 'client:' THEN NEW.created_by ELSE '' END;
END;

-- Audit actors and Operator Token creators are full principals.
UPDATE supertag_v2_audit_entries SET actor = 'operator:' || actor
WHERE instr(actor, ':') = 0 OR substr(actor, 1, 6) = 'token:';
UPDATE supertag_v2_operator_tokens SET created_by = 'operator:' || created_by
WHERE instr(created_by, ':') = 0 OR substr(created_by, 1, 6) = 'token:';

UPDATE supertag_v2_schema SET version=70 WHERE version=69;
