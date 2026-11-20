-- One input queue per Session (session-input-queue stage 2). Every input to a Session is one row,
-- ordered per Session, with an idempotency key from its source: a request, a person's message, a
-- surface event, a Tag's message, a Schedule fire, a work Session report, a decision, or a notice.
-- It replaces live inputs (supertag_v2_live_inputs and their resolutions), wake rows
-- (supertag_v2_wakes), and inbox Task links (supertag_v2_mailbox_tasks).

-- kind: 1 request, 2 person message, 3 surface event, 4 Tag message, 5 Schedule fire,
-- 6 work Session report, 7 decision (approval decision, question answer, Objective review
-- feedback), 8 notice (Objective budget, deadline, idle, resume; approval budget stop).
-- admitted_task_id is the Task admitted for the input (for a Tag message, the inbox Task that
-- reserved it); task_id is the run that bound it, NULL while it waits. offer_state is the
-- LiveInputState of a person's message offered to a running Attempt.
CREATE TABLE supertag_v2_session_inputs (
    input_id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    session_id TEXT NOT NULL,
    -- From the global write order: unique, and in commit order.
    position BIGINT NOT NULL UNIQUE CHECK (position > 0),
    kind BIGINT NOT NULL CHECK (kind BETWEEN 1 AND 8),
    -- From the source; fields joined by a newline.
    source_key TEXT NOT NULL UNIQUE,
    -- Who the input acts for: `operator:…`/`client:…`, `connector:<account>`, `tag:<id>`,
    -- `schedule:<id>`, `objective:<id>`, `work-session:<id>`.
    requester TEXT NOT NULL,
    -- Who sees the reply: the Task audience owner, '' for none.
    audience TEXT NOT NULL,
    admitted_task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    bound_at_ms BIGINT,
    -- Bound by the first claim of an earlier Task (a joined message).
    bound_at_claim BIGINT NOT NULL DEFAULT 0 CHECK (bound_at_claim IN (0, 1)),
    created_at_ms BIGINT NOT NULL,
    offer_task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    offer_attempt_id TEXT,
    offer_state BIGINT CHECK (offer_state BETWEEN 1 AND 8),
    acknowledgement_deadline_ms BIGINT,
    resolution_principal TEXT,
    resolution_operation_id TEXT,
    resolution_decision BIGINT CHECK (resolution_decision IN (1, 2)),
    resolution_evidence TEXT,
    resolved_at_ms BIGINT,
    -- Tag messages (kind 4): the direct conversation and seq range.
    conversation_id TEXT REFERENCES supertag_v2_conversations(conversation_id),
    reasons BIGINT,
    priority BIGINT,
    first_seq BIGINT,
    last_seq BIGINT,
    through_seq BIGINT,
    hops BIGINT,
    origin_task_id TEXT,
    objective_id TEXT,
    -- NULL: held by a wake limit or the backlog; bound by the Tag's next inbox turn, wakes nobody.
    not_before_ms BIGINT,
    deferred_reason TEXT,
    release_task_id TEXT,
    CHECK ((task_id IS NULL) = (bound_at_ms IS NULL)),
    CHECK ((kind = 4) = (conversation_id IS NOT NULL)),
    CHECK (kind = 4 OR admitted_task_id IS NOT NULL),
    CHECK (kind <> 4 OR (reasons > 0 AND priority BETWEEN 1 AND 3 AND first_seq > 0
        AND last_seq >= first_seq AND hops BETWEEN 0 AND 4)),
    CHECK (kind <> 4 OR ((task_id IS NULL) = (through_seq IS NULL))),
    CHECK (through_seq IS NULL OR through_seq >= first_seq),
    CHECK ((offer_state IS NULL) = (offer_task_id IS NULL)),
    CHECK ((offer_task_id IS NULL) = (offer_attempt_id IS NULL)),
    CHECK (offer_state IS NULL OR kind = 2),
    CHECK ((resolution_principal IS NULL) = (resolved_at_ms IS NULL))
);
-- Pending inputs of a Session in order.
CREATE INDEX supertag_v2_session_inputs_pending
    ON supertag_v2_session_inputs(tag_id, session_id, position) WHERE task_id IS NULL;
-- What a run bound, in order.
CREATE INDEX supertag_v2_session_inputs_bound
    ON supertag_v2_session_inputs(task_id, position) WHERE task_id IS NOT NULL;
-- One input per admitted Task, except an inbox Task's reserved Tag messages.
CREATE UNIQUE INDEX supertag_v2_session_inputs_admitted
    ON supertag_v2_session_inputs(admitted_task_id) WHERE conversation_id IS NULL;
CREATE INDEX supertag_v2_session_inputs_reserved
    ON supertag_v2_session_inputs(admitted_task_id) WHERE conversation_id IS NOT NULL;
-- Live input: offers by target Attempt, acknowledgement sweep, claim holds, recovery receipts.
CREATE INDEX supertag_v2_session_inputs_offered
    ON supertag_v2_session_inputs(offer_task_id, offer_attempt_id, offer_state)
    WHERE offer_state IS NOT NULL;
CREATE INDEX supertag_v2_session_inputs_unsettled
    ON supertag_v2_session_inputs(offer_state, acknowledgement_deadline_ms)
    WHERE offer_state IN (1, 2, 5);
CREATE INDEX supertag_v2_session_inputs_held
    ON supertag_v2_session_inputs(tag_id, session_id, position) WHERE offer_state IN (2, 5);
CREATE UNIQUE INDEX supertag_v2_session_inputs_resolution
    ON supertag_v2_session_inputs(resolution_principal, resolution_operation_id)
    WHERE resolution_principal IS NOT NULL;
-- Tag messages: one pending row per Tag and conversation (coalescing), due order, delivery.
CREATE UNIQUE INDEX supertag_v2_session_inputs_coalesce
    ON supertag_v2_session_inputs(tag_id, conversation_id)
    WHERE task_id IS NULL AND conversation_id IS NOT NULL;
CREATE INDEX supertag_v2_session_inputs_due
    ON supertag_v2_session_inputs(not_before_ms)
    WHERE task_id IS NULL AND conversation_id IS NOT NULL;
CREATE INDEX supertag_v2_session_inputs_wake_queue
    ON supertag_v2_session_inputs(tag_id, priority, not_before_ms)
    WHERE task_id IS NULL AND conversation_id IS NOT NULL;
CREATE INDEX supertag_v2_session_inputs_delivered
    ON supertag_v2_session_inputs(tag_id, conversation_id, first_seq)
    WHERE task_id IS NOT NULL AND conversation_id IS NOT NULL;
CREATE INDEX supertag_v2_session_inputs_release
    ON supertag_v2_session_inputs(release_task_id)
    WHERE task_id IS NULL AND release_task_id IS NOT NULL;

-- 1. Live inputs, settled ones too: a conversation shows them and earlier claims replay them.
-- A person's message offered to a running Attempt; Accepted means the target bound it.
INSERT INTO supertag_v2_session_inputs
    (input_id, tag_id, session_id, position, kind, source_key, requester, audience,
     admitted_task_id, task_id, bound_at_ms, bound_at_claim, created_at_ms,
     offer_task_id, offer_attempt_id, offer_state, acknowledgement_deadline_ms,
     resolution_principal, resolution_operation_id, resolution_decision,
     resolution_evidence, resolved_at_ms)
SELECT i.input_id, f.tag_id, f.session_id, f.accepted_order, 2,
       'live' || chr(10) || i.operator_principal || chr(10) || i.operation_id,
       CASE WHEN i.operator_principal = 'control-plane:join'
            THEN COALESCE(NULLIF(a.owner, ''),
                 (SELECT 'connector:' || e.account_id FROM supertag_v2_inbound_events e
                  WHERE e.task_id = f.task_id), '')
            ELSE i.operator_principal END,
       COALESCE(a.owner, ''), i.follower_task_id,
       CASE WHEN i.state = 3 THEN i.task_id
            WHEN EXISTS (SELECT 1 FROM supertag_v2_claims c WHERE c.task_id = f.task_id)
            THEN f.task_id END,
       CASE WHEN i.state = 3 OR EXISTS (SELECT 1 FROM supertag_v2_claims c
            WHERE c.task_id = f.task_id) THEN COALESCE(f.accepted_at_ms, 0) END,
       i.joined_at_claim, COALESCE(f.accepted_at_ms, 0),
       i.task_id, i.attempt_id, i.state, i.acknowledgement_deadline_ms,
       r.operator_principal, r.operation_id, r.decision, r.evidence, r.resolved_at_ms
FROM supertag_v2_live_inputs i
JOIN supertag_v2_tasks f ON f.task_id = i.follower_task_id
LEFT JOIN supertag_v2_task_audience a ON a.task_id = f.task_id
LEFT JOIN supertag_v2_live_input_resolutions r ON r.input_id = i.input_id;

-- 2. Unfinished admitted Tasks (Queued, Running, Claimed, Uncertain) outside inbox Sessions:
-- what each was admitted for. The first match wins; the order matters, since approval
-- continuations and budget stops are conversation turns, and Schedule and report routes are
-- inbound events.
CREATE TEMP TABLE supertag_v2_m122_admitted AS
SELECT t.task_id, t.tag_id, t.session_id, t.accepted_order,
       COALESCE(t.accepted_at_ms, 0) AS accepted_at_ms,
       COALESCE(a.owner, '') AS owner,
       (SELECT MIN(c.claimed_at_ms) FROM supertag_v2_claims c WHERE c.task_id = t.task_id)
           AS claimed_at_ms,
       EXISTS (SELECT 1 FROM supertag_v2_claims c WHERE c.task_id = t.task_id) AS claimed,
       (SELECT 'schedule' || chr(10) || f.schedule_id || chr(10) || f.due_at_ms
        FROM supertag_v2_schedule_fires f WHERE f.task_id = t.task_id) AS fire_key,
       (SELECT COALESCE(s.audience_principal,
               (SELECT 'connector:' || e.account_id FROM supertag_v2_inbound_events e
                WHERE e.task_id = t.task_id), 'schedule:' || s.schedule_id)
        FROM supertag_v2_schedule_fires f JOIN supertag_v2_schedules s
          ON s.schedule_id = f.schedule_id WHERE f.task_id = t.task_id) AS fire_requester,
       (SELECT 'report' || chr(10) || r.child_task_id FROM supertag_v2_work_session_reports r
        WHERE r.report_task_id = t.task_id) AS report_key,
       (SELECT 'work-session:' || r.work_session_id FROM supertag_v2_work_session_reports r
        WHERE r.report_task_id = t.task_id) AS report_requester,
       (SELECT 'approval' || chr(10) || w.task_id FROM supertag_v2_approval_waits w
        WHERE w.continuation_task_id = t.task_id) AS approval_key,
       (SELECT 'answer' || chr(10) || q.principal || chr(10) || q.operation_id
        FROM supertag_v2_question_answers q WHERE q.answer_task_id = t.task_id
        ORDER BY q.principal, q.operation_id LIMIT 1) AS answer_key,
       (SELECT q.principal FROM supertag_v2_question_answers q
        WHERE q.answer_task_id = t.task_id
        ORDER BY q.principal, q.operation_id LIMIT 1) AS answer_requester,
       (SELECT 'objective' || chr(10) || n.objective_id || chr(10) || n.notice_key
        FROM supertag_v2_objective_notices n WHERE n.task_id = t.task_id) AS notice_key,
       (SELECT COALESCE(NULLIF(o.created_by, ''), 'objective:' || o.objective_id)
        FROM supertag_v2_objective_notices n JOIN supertag_v2_objectives o
          ON o.objective_id = n.objective_id WHERE n.task_id = t.task_id) AS notice_requester,
       (SELECT ot.kind FROM supertag_v2_objective_tasks ot WHERE ot.task_id = t.task_id)
           AS objective_kind,
       (SELECT 'approval-budget-stop' || chr(10) || substr(e.event_id, 22)
        FROM supertag_v2_inbound_events e WHERE e.task_id = t.task_id
          AND e.event_id LIKE 'approval-budget-stop:%') AS budget_key,
       (SELECT COALESCE((SELECT 'conversation' || chr(10) || o.scope_id || chr(10) || o.operation_id
                         FROM supertag_v2_message_operations o
                         WHERE o.scope = 3 AND o.message_id = m.message_id
                         ORDER BY o.scope_id, o.operation_id LIMIT 1),
                        'task' || chr(10) || t.task_id)
        FROM supertag_v2_messages m WHERE m.task_id = t.task_id AND m.sender_kind = 2)
           AS message_key,
       (SELECT m.sender_id FROM supertag_v2_messages m
        WHERE m.task_id = t.task_id AND m.sender_kind = 2) AS message_requester,
       (SELECT 'connector:' || x.account_id FROM (
            SELECT account_id FROM supertag_v2_slack_messages WHERE task_id = t.task_id
            UNION ALL SELECT account_id FROM supertag_v2_lark_messages WHERE task_id = t.task_id
            UNION ALL SELECT account_id FROM supertag_v2_microsoft_teams_activities
                WHERE task_id = t.task_id) x LIMIT 1) AS chat_requester,
       (SELECT 'surface' || chr(10) || e.account_id || chr(10) || e.event_id
        FROM supertag_v2_inbound_events e WHERE e.task_id = t.task_id) AS event_key,
       (SELECT 'connector:' || e.account_id FROM supertag_v2_inbound_events e
        WHERE e.task_id = t.task_id) AS event_requester,
       (SELECT 'request' || chr(10) || d.principal || chr(10) || d.operation_id
        FROM supertag_v2_admissions d WHERE d.task_id = t.task_id) AS request_key,
       (SELECT d.principal FROM supertag_v2_admissions d WHERE d.task_id = t.task_id)
           AS request_requester,
       (SELECT 'objective-home' || chr(10) || o.objective_id FROM supertag_v2_objectives o
        WHERE o.home_task_id = t.task_id) AS home_key,
       (SELECT COALESCE(NULLIF(o.created_by, ''), 'objective:' || o.objective_id)
        FROM supertag_v2_objectives o WHERE o.home_task_id = t.task_id) AS home_requester
FROM supertag_v2_tasks t
LEFT JOIN supertag_v2_task_audience a ON a.task_id = t.task_id
WHERE t.state IN (1, 2, 6, 7) AND t.session_id NOT LIKE 'inbox:%'
  AND NOT EXISTS (SELECT 1 FROM supertag_v2_session_inputs i WHERE i.admitted_task_id = t.task_id);

INSERT INTO supertag_v2_session_inputs
    (input_id, tag_id, session_id, position, kind, source_key, requester, audience,
     admitted_task_id, task_id, bound_at_ms, created_at_ms)
SELECT 'm122-task-' || task_id, tag_id, session_id, accepted_order, kind, source_key,
       requester, owner, task_id,
       CASE WHEN claimed THEN task_id END,
       CASE WHEN claimed THEN COALESCE(claimed_at_ms, 0) END,
       accepted_at_ms
FROM (
    SELECT x.*,
        CASE WHEN fire_key IS NOT NULL THEN 5
             WHEN report_key IS NOT NULL THEN 6
             WHEN approval_key IS NOT NULL THEN 7
             WHEN answer_key IS NOT NULL THEN 7
             WHEN notice_key IS NOT NULL THEN CASE WHEN objective_kind = 'work' THEN 7 ELSE 8 END
             WHEN budget_key IS NOT NULL THEN 8
             WHEN message_key IS NOT NULL THEN 2
             WHEN chat_requester IS NOT NULL THEN 2
             WHEN event_key IS NOT NULL THEN 3
             WHEN request_key IS NOT NULL THEN 1
             WHEN home_key IS NOT NULL THEN 1 END AS kind,
        CASE WHEN fire_key IS NOT NULL THEN fire_key
             WHEN report_key IS NOT NULL THEN report_key
             WHEN approval_key IS NOT NULL THEN approval_key
             WHEN answer_key IS NOT NULL THEN answer_key
             WHEN notice_key IS NOT NULL THEN notice_key
             WHEN budget_key IS NOT NULL THEN budget_key
             WHEN message_key IS NOT NULL THEN message_key
             WHEN chat_requester IS NOT NULL
                 THEN COALESCE(event_key, 'task' || chr(10) || task_id)
             WHEN event_key IS NOT NULL THEN event_key
             WHEN request_key IS NOT NULL THEN request_key
             WHEN home_key IS NOT NULL THEN home_key END AS source_key,
        CASE WHEN fire_key IS NOT NULL THEN fire_requester
             WHEN report_key IS NOT NULL THEN COALESCE(NULLIF(owner, ''), report_requester)
             WHEN approval_key IS NOT NULL THEN COALESCE(NULLIF(owner, ''), 'tag:' || tag_id)
             WHEN answer_key IS NOT NULL THEN answer_requester
             WHEN notice_key IS NOT NULL THEN notice_requester
             WHEN budget_key IS NOT NULL THEN COALESCE(NULLIF(owner, ''), 'tag:' || tag_id)
             WHEN message_key IS NOT NULL THEN message_requester
             WHEN chat_requester IS NOT NULL THEN chat_requester
             WHEN event_key IS NOT NULL THEN event_requester
             WHEN request_key IS NOT NULL THEN request_requester
             WHEN home_key IS NOT NULL THEN home_requester END AS requester
    FROM supertag_v2_m122_admitted x
) classified
WHERE kind IS NOT NULL;

DROP TABLE supertag_v2_m122_admitted;

-- 3. Wakes, bound ones too: they are delivery records. A Tag message's position continues the
-- write order.
INSERT INTO supertag_v2_session_inputs
    (input_id, tag_id, session_id, position, kind, source_key, requester, audience,
     admitted_task_id, task_id, bound_at_ms, created_at_ms, conversation_id, reasons, priority,
     first_seq, last_seq, through_seq, hops, origin_task_id, objective_id, not_before_ms,
     deferred_reason, release_task_id)
SELECT w.wake_id, w.tag_id, 'inbox:' || w.tag_id,
       (SELECT MAX(v) FROM (
            SELECT revision AS v FROM supertag_v2_write_order WHERE singleton = 1
            UNION ALL SELECT MAX(accepted_order) FROM supertag_v2_tasks
            UNION ALL SELECT MAX(position) FROM supertag_v2_session_inputs) base)
           + ROW_NUMBER() OVER (ORDER BY w.created_at_ms, w.wake_id),
       4, 'wake' || chr(10) || w.wake_id,
       'tag:' || COALESCE((SELECT m.sender_id FROM supertag_v2_messages m
                           WHERE m.conversation_id = w.conversation_id AND m.seq = w.first_seq),
                          ''),
       '', w.task_id, w.task_id,
       CASE WHEN w.task_id IS NOT NULL THEN COALESCE(w.bound_at_ms, w.created_at_ms) END,
       w.created_at_ms, w.conversation_id, w.reasons, w.priority, w.first_seq, w.last_seq,
       w.through_seq, w.hops, w.origin_task_id, w.objective_id, w.not_before_ms,
       w.deferred_reason, w.release_task_id
FROM supertag_v2_wakes w;

-- 4. Held messages: direct messages a wake limit or the backlog held, which have no wake. Each
-- conversation's gets one held row (no due time), which the Tag's next inbox turn binds.
INSERT INTO supertag_v2_session_inputs
    (input_id, tag_id, session_id, position, kind, source_key, requester, audience,
     created_at_ms, conversation_id, reasons, priority, first_seq, last_seq, hops,
     origin_task_id, objective_id)
SELECT 'm122-held-' || h.conversation_id || '-' || h.tag_id, h.tag_id, 'inbox:' || h.tag_id,
       (SELECT MAX(v) FROM (
            SELECT revision AS v FROM supertag_v2_write_order WHERE singleton = 1
            UNION ALL SELECT MAX(accepted_order) FROM supertag_v2_tasks
            UNION ALL SELECT MAX(position) FROM supertag_v2_session_inputs) base)
           + ROW_NUMBER() OVER (ORDER BY h.conversation_id, h.tag_id),
       4, 'wake' || chr(10) || 'm122-held-' || h.conversation_id || '-' || h.tag_id,
       'tag:' || first.sender_id, '', first.created_at_ms, h.conversation_id, 1, 1,
       h.delivered_seq + 1, h.last_seq, h.hops, first.origin_task_id, first.objective_id
FROM (
    SELECT mem.conversation_id, mem.member_id AS tag_id, mem.delivered_seq,
           MIN(a.seq) AS first_addressed, MAX(a.seq) AS last_seq, MAX(m.hops) AS hops
    FROM supertag_v2_conversation_members mem
    JOIN supertag_v2_conversations c ON c.conversation_id = mem.conversation_id AND c.kind = 1
    JOIN supertag_v2_message_addressees a ON a.conversation_id = mem.conversation_id
        AND a.tag_id = mem.member_id AND a.seq > mem.delivered_seq
    JOIN supertag_v2_messages m ON m.conversation_id = a.conversation_id AND m.seq = a.seq
    JOIN supertag_v2_tags tag ON tag.tag_id = mem.member_id
    WHERE mem.member_kind = 1
      AND NOT EXISTS (SELECT 1 FROM supertag_v2_session_inputs w
                      WHERE w.tag_id = mem.member_id AND w.conversation_id = mem.conversation_id
                        AND w.task_id IS NULL)
    GROUP BY mem.conversation_id, mem.member_id, mem.delivered_seq
) h
JOIN supertag_v2_messages first ON first.conversation_id = h.conversation_id
    AND first.seq = h.first_addressed;

-- 5. Reservations replace inbox Task links: a Tag's waiting inbox Task reserves its pending
-- messages. One with none to deliver would fail at its start; it is cancelled.
UPDATE supertag_v2_session_inputs SET admitted_task_id = (
    SELECT mt.task_id FROM supertag_v2_mailbox_tasks mt
    JOIN supertag_v2_tasks t ON t.task_id = mt.task_id
    WHERE mt.recipient_tag_id = supertag_v2_session_inputs.tag_id AND mt.bound = 0
      AND t.state IN (1, 6)
    ORDER BY t.accepted_order LIMIT 1)
WHERE task_id IS NULL AND conversation_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM supertag_v2_mailbox_tasks mt
    JOIN supertag_v2_tasks t ON t.task_id = mt.task_id
    WHERE mt.recipient_tag_id = supertag_v2_session_inputs.tag_id AND mt.bound = 0
      AND t.state IN (1, 6));

UPDATE supertag_v2_tasks SET state = 5, result = 'inbox Task has no waiting messages'
WHERE state = 1 AND attempt_id IS NULL AND task_id IN (
    SELECT mt.task_id FROM supertag_v2_mailbox_tasks mt WHERE mt.bound = 0
      AND NOT EXISTS (SELECT 1 FROM supertag_v2_session_inputs r
                      WHERE r.admitted_task_id = mt.task_id));

-- 6. The write order continues after every position taken.
UPDATE supertag_v2_write_order SET revision = (
    SELECT MAX(v) FROM (
        SELECT revision AS v FROM supertag_v2_write_order WHERE singleton = 1
        UNION ALL SELECT MAX(position) FROM supertag_v2_session_inputs) base)
WHERE singleton = 1;

-- 7. The replaced tables. Wake counts, pairs, and limit trips stay.
DROP TABLE supertag_v2_live_input_resolutions;
DROP TABLE supertag_v2_live_inputs;
DROP FUNCTION supertag_v2_watch_live_input_changed();
DROP TABLE supertag_v2_wakes;
DROP TABLE supertag_v2_mailbox_tasks;

-- A live input's change of state shows on its follower Task's watch, as before. The first offer
-- (Pending) is not a change.
CREATE FUNCTION supertag_v2_watch_session_input_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 3, 2, task_id, tag_id, session_id, objective_id, '', conversation, owner
        FROM supertag_v2_watch_tasks WHERE task_id = NEW.admitted_task_id AND owner <> '';
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_session_input_offer
AFTER UPDATE OF offer_state ON supertag_v2_session_inputs
FOR EACH ROW WHEN (OLD.offer_state IS NOT NULL AND NEW.offer_state IS DISTINCT FROM OLD.offer_state)
EXECUTE FUNCTION supertag_v2_watch_session_input_offer();

UPDATE supertag_v2_schema SET version=122 WHERE version=121;
