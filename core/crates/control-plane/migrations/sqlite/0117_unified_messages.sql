-- One message model for Tags' Mailbox and Workstream (messaging phase 2). A conversation is a
-- direct conversation between two members, a Team's channel, or a thread under a message. Each
-- conversation numbers its own messages (seq), so writers to different conversations never wait
-- on one counter. Member rows hold read and delivery positions; wake rows say which Tag must take
-- a turn for which messages, and which inbox Task delivered them. Mailbox and Workstream stay the
-- names users and Tags see: a direct conversation between Tags is the Mailbox, and a Team's
-- channel is its Workstream.
--
-- Existing Mailbox messages, Workstream posts, their delivery state, and their operation receipts
-- are copied here with their IDs. The old tables stay until the code that writes them moves to
-- this model; that change drops them.
PRAGMA defer_foreign_keys = ON;

-- 0083's rows are the Sessions of a person's conversation with a Tag. The unified table takes the
-- name; the rename also rewrites the foreign key from conversation_messages and the audience views.
ALTER TABLE supertag_v2_conversations RENAME TO supertag_v2_conversation_sessions;

-- kind: 1 direct, 2 channel, 3 thread, 4 surface (reserved).
CREATE TABLE supertag_v2_conversations (
    conversation_id TEXT PRIMARY KEY,
    kind BIGINT NOT NULL CHECK (kind IN (1, 2, 3, 4)),
    -- A direct conversation's two members, `t:<tag>` or `p:<principal>`, sorted and joined by a
    -- newline.
    direct_key TEXT UNIQUE,
    team_id TEXT REFERENCES supertag_v2_teams(team_id) ON DELETE SET NULL,
    -- NULL for a Team's one channel; reserved for more channels per Team.
    name TEXT,
    parent_conversation_id TEXT,
    parent_seq BIGINT,
    next_seq BIGINT NOT NULL DEFAULT 1 CHECK (next_seq > 0),
    created_at_ms BIGINT NOT NULL,
    archived_at_ms BIGINT,
    CHECK ((kind = 1) = (direct_key IS NOT NULL)),
    CHECK ((kind = 3) = (parent_conversation_id IS NOT NULL AND parent_seq IS NOT NULL)),
    CHECK (kind <> 2 OR team_id IS NOT NULL OR archived_at_ms IS NOT NULL),
    FOREIGN KEY (parent_conversation_id, parent_seq)
        REFERENCES supertag_v2_messages(conversation_id, seq)
);
CREATE UNIQUE INDEX supertag_v2_conversations_team_channel ON supertag_v2_conversations(team_id)
    WHERE kind = 2 AND name IS NULL AND archived_at_ms IS NULL;
CREATE INDEX supertag_v2_conversations_parent
    ON supertag_v2_conversations(parent_conversation_id, parent_seq) WHERE kind = 3;

-- sender_kind: 1 Tag, 2 principal. kind: 1 note, 2 question, 3 blocker, 4 evidence, 5 decision,
-- 6 review (a commit review request; only the Control Plane sets it).
CREATE TABLE supertag_v2_messages (
    conversation_id TEXT NOT NULL REFERENCES supertag_v2_conversations(conversation_id),
    seq BIGINT NOT NULL CHECK (seq > 0),
    message_id TEXT NOT NULL UNIQUE,
    sender_kind BIGINT NOT NULL CHECK (sender_kind IN (1, 2)),
    sender_id TEXT NOT NULL,
    kind BIGINT NOT NULL CHECK (kind BETWEEN 1 AND 6),
    -- Empty only for a person conversation's turn, whose content is its Task.
    text TEXT NOT NULL,
    hops BIGINT NOT NULL DEFAULT 0 CHECK (hops BETWEEN 0 AND 4),
    source_task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    -- The Task that started the chain this message continues (wake limits).
    origin_task_id TEXT,
    objective_id TEXT,
    -- A person conversation's turn: the Task the message is.
    task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    -- Identical Workstream posts from one Task are one post.
    effect_digest TEXT,
    created_at_ms BIGINT NOT NULL,
    PRIMARY KEY (conversation_id, seq),
    CHECK (task_id IS NOT NULL OR text <> '')
);
CREATE INDEX supertag_v2_messages_source ON supertag_v2_messages(source_task_id, conversation_id);
CREATE UNIQUE INDEX supertag_v2_messages_effect
    ON supertag_v2_messages(conversation_id, source_task_id, effect_digest)
    WHERE effect_digest IS NOT NULL;

-- The Tags a Tag's message names: the recipient of a direct message, the `to` of a post. Sender
-- and time are copied so a Tag's Mailbox is one index-ordered scan.
CREATE TABLE supertag_v2_message_addressees (
    conversation_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    sender_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    created_at_ms BIGINT NOT NULL,
    PRIMARY KEY (conversation_id, seq, tag_id),
    FOREIGN KEY (conversation_id, seq) REFERENCES supertag_v2_messages(conversation_id, seq),
    CHECK (tag_id <> sender_tag_id)
);
CREATE INDEX supertag_v2_message_addressees_to
    ON supertag_v2_message_addressees(tag_id, created_at_ms, conversation_id, seq);
CREATE INDEX supertag_v2_message_addressees_from
    ON supertag_v2_message_addressees(sender_tag_id, created_at_ms, conversation_id, seq);

-- Permission to read, and the cursor. A person's devices share this row. member_kind: 1 Tag,
-- 2 principal. "Seen" by a Tag means claimed by one of its turns: delivered_seq.
CREATE TABLE supertag_v2_conversation_members (
    conversation_id TEXT NOT NULL REFERENCES supertag_v2_conversations(conversation_id),
    member_kind BIGINT NOT NULL CHECK (member_kind IN (1, 2)),
    member_id TEXT NOT NULL,
    read_seq BIGINT NOT NULL DEFAULT 0 CHECK (read_seq >= 0),
    delivered_seq BIGINT NOT NULL DEFAULT 0 CHECK (delivered_seq >= 0),
    mention_count BIGINT NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
    -- 0 default, 1 all, 2 mentions only, 3 none.
    notify BIGINT NOT NULL DEFAULT 0 CHECK (notify BETWEEN 0 AND 3),
    joined_at_ms BIGINT NOT NULL,
    read_at_ms BIGINT,
    -- A Tag that left the Team keeps its cursor but no longer reads the channel.
    left_at_ms BIGINT,
    PRIMARY KEY (conversation_id, member_kind, member_id)
);
CREATE INDEX supertag_v2_conversation_members_member
    ON supertag_v2_conversation_members(member_kind, member_id, conversation_id);

-- Idempotency for every send. Scope 1: a Task's Mailbox sends; 2: a Task's Workstream posts;
-- 3: a principal's conversation messages.
CREATE TABLE supertag_v2_message_operations (
    scope BIGINT NOT NULL CHECK (scope IN (1, 2, 3)),
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES supertag_v2_messages(message_id),
    PRIMARY KEY (scope, scope_id, operation_id)
);

-- Delivery to Tags. A pending wake (task_id NULL) is coalesced per Tag and conversation; a bound
-- wake records which inbox Task delivered seq first_seq..through_seq. reasons is a bit set:
-- 1 direct, 2 addressed, 4 question, 8 blocker, 16 review. priority: 1 note, evidence, or
-- decision; 2 question or review; 3 blocker.
CREATE TABLE supertag_v2_wakes (
    wake_id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    conversation_id TEXT NOT NULL REFERENCES supertag_v2_conversations(conversation_id),
    reasons BIGINT NOT NULL CHECK (reasons > 0),
    priority BIGINT NOT NULL CHECK (priority BETWEEN 1 AND 3),
    first_seq BIGINT NOT NULL CHECK (first_seq > 0),
    last_seq BIGINT NOT NULL,
    hops BIGINT NOT NULL CHECK (hops BETWEEN 0 AND 4),
    origin_task_id TEXT,
    objective_id TEXT,
    not_before_ms BIGINT NOT NULL,
    -- Why a question or blocker over a wake limit waits; shown in the inbox turn.
    deferred_reason TEXT,
    created_at_ms BIGINT NOT NULL,
    task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    through_seq BIGINT,
    bound_at_ms BIGINT,
    CHECK (last_seq >= first_seq),
    CHECK ((task_id IS NULL) = (through_seq IS NULL)),
    CHECK (through_seq IS NULL OR through_seq >= first_seq)
);
CREATE UNIQUE INDEX supertag_v2_wakes_pending ON supertag_v2_wakes(tag_id, conversation_id)
    WHERE task_id IS NULL;
CREATE INDEX supertag_v2_wakes_queue ON supertag_v2_wakes(tag_id, priority, not_before_ms)
    WHERE task_id IS NULL;
CREATE INDEX supertag_v2_wakes_due ON supertag_v2_wakes(not_before_ms) WHERE task_id IS NULL;
CREATE INDEX supertag_v2_wakes_task ON supertag_v2_wakes(task_id);

-- Wake limits. Fixed hour windows: window_start_ms = now - now % 3600000. scope: 1 woken Tag,
-- 2 Objective.
CREATE TABLE supertag_v2_wake_counts (
    scope BIGINT NOT NULL CHECK (scope IN (1, 2)),
    scope_id TEXT NOT NULL,
    window_start_ms BIGINT NOT NULL,
    wakes BIGINT NOT NULL CHECK (wakes >= 0),
    PRIMARY KEY (scope, scope_id, window_start_ms)
);
-- Mutual wakes between two Tags (sorted) for one originating Task, both directions.
CREATE TABLE supertag_v2_wake_pairs (
    origin_task_id TEXT NOT NULL,
    tag_a TEXT NOT NULL,
    tag_b TEXT NOT NULL,
    wakes BIGINT NOT NULL CHECK (wakes >= 0),
    PRIMARY KEY (origin_task_id, tag_a, tag_b),
    CHECK (tag_a < tag_b)
);
-- One operator Inbox item per tripped limit and window. scope: 1 Tag per hour, 2 Objective per
-- hour, 3 pair per Task. scope_id: the Tag ID, the Objective ID, or the origin Task ID, tag_a, and
-- tag_b joined by newlines. window_start_ms is 0 for a pair.
CREATE TABLE supertag_v2_wake_limit_trips (
    scope BIGINT NOT NULL CHECK (scope IN (1, 2, 3)),
    scope_id TEXT NOT NULL,
    window_start_ms BIGINT NOT NULL,
    team_id TEXT,
    objective_id TEXT,
    sender_tag_id TEXT NOT NULL,
    recipient_tag_id TEXT NOT NULL,
    wake_limit BIGINT NOT NULL,
    held BIGINT NOT NULL DEFAULT 0 CHECK (held >= 0),
    tripped_at_ms BIGINT NOT NULL,
    PRIMARY KEY (scope, scope_id, window_start_ms)
);
CREATE INDEX supertag_v2_wake_limit_trips_time ON supertag_v2_wake_limit_trips(tripped_at_ms);

-- Per-Team overrides of the wake limits; NULL keeps the default.
ALTER TABLE supertag_v2_teams ADD COLUMN wake_mutual_limit BIGINT
    CHECK (wake_mutual_limit BETWEEN 0 AND 1000);
ALTER TABLE supertag_v2_teams ADD COLUMN wake_tag_hourly_limit BIGINT
    CHECK (wake_tag_hourly_limit BETWEEN 0 AND 1000);
ALTER TABLE supertag_v2_teams ADD COLUMN wake_objective_hourly_limit BIGINT
    CHECK (wake_objective_hourly_limit BETWEEN 0 AND 1000);

-- Data. Rows map back through team_id and direct_key, never through a generated ID.

-- 1. One channel per Team, continuing its Workstream sequence.
INSERT INTO supertag_v2_conversations (conversation_id, kind, team_id, next_seq, created_at_ms)
SELECT 'channel/' || lower(hex(randomblob(16))), 2, team_id, next_post_sequence, created_at_ms
FROM supertag_v2_teams;

-- 2. Posts become channel messages with their sequence and ID.
INSERT INTO supertag_v2_messages
    (conversation_id, seq, message_id, sender_kind, sender_id, kind, text, hops, source_task_id,
     origin_task_id, objective_id, effect_digest, created_at_ms)
SELECT c.conversation_id, p.sequence, p.post_id, 1, p.author_tag_id, 1, p.body,
       COALESCE((SELECT MAX(m.hops) FROM supertag_v2_mailbox_messages m
                 WHERE m.origin = 2 AND m.workstream_post_id = p.post_id), 0),
       p.source_task_id, p.source_task_id,
       COALESCE((SELECT o.objective_id FROM supertag_v2_objective_tasks o
                 WHERE o.task_id = p.source_task_id),
                (SELECT MIN(m.objective_id) FROM supertag_v2_mailbox_messages m
                 WHERE m.origin = 2 AND m.workstream_post_id = p.post_id)),
       p.effect_digest, p.created_at_ms
FROM supertag_v2_workstream_posts p
JOIN supertag_v2_conversations c ON c.kind = 2 AND c.team_id = p.team_id;
INSERT INTO supertag_v2_message_addressees (conversation_id, seq, tag_id, sender_tag_id, created_at_ms)
SELECT DISTINCT c.conversation_id, p.sequence, j.value, p.author_tag_id, p.created_at_ms
FROM supertag_v2_workstream_posts p
JOIN supertag_v2_conversations c ON c.kind = 2 AND c.team_id = p.team_id
JOIN json_each(p.to_tag_ids) j
WHERE j.value <> p.author_tag_id
  AND EXISTS (SELECT 1 FROM supertag_v2_tags tag WHERE tag.tag_id = j.value);

-- 3. Addressed copies of posts whose Team was deleted keep their content in one archived channel
-- with no members.
CREATE TEMPORARY TABLE supertag_v2_m117_orphans AS
SELECT workstream_post_id AS post_id, MIN(sender_tag_id) AS sender_tag_id, MIN(text) AS text,
       MAX(hops) AS hops, MIN(source_task_id) AS source_task_id, MIN(objective_id) AS objective_id,
       MIN(created_at_ms) AS created_at_ms, MIN(delivery_order) AS first_order
FROM supertag_v2_mailbox_messages m
WHERE origin = 2
  AND NOT EXISTS (SELECT 1 FROM supertag_v2_workstream_posts p WHERE p.post_id = m.workstream_post_id)
GROUP BY workstream_post_id;
INSERT INTO supertag_v2_conversations
    (conversation_id, kind, name, next_seq, created_at_ms, archived_at_ms)
SELECT 'channel/' || lower(hex(randomblob(16))), 2, 'deleted teams', COUNT(*) + 1,
       MIN(created_at_ms),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM supertag_v2_m117_orphans
HAVING COUNT(*) > 0;
INSERT INTO supertag_v2_messages
    (conversation_id, seq, message_id, sender_kind, sender_id, kind, text, hops, source_task_id,
     origin_task_id, objective_id, created_at_ms)
SELECT c.conversation_id, ROW_NUMBER() OVER (ORDER BY o.first_order), o.post_id, 1,
       o.sender_tag_id, 1, o.text, o.hops, o.source_task_id, o.source_task_id, o.objective_id,
       o.created_at_ms
FROM supertag_v2_m117_orphans o
JOIN supertag_v2_conversations c ON c.kind = 2 AND c.team_id IS NULL AND c.name = 'deleted teams';
INSERT INTO supertag_v2_message_addressees (conversation_id, seq, tag_id, sender_tag_id, created_at_ms)
SELECT msg.conversation_id, msg.seq, m.recipient_tag_id, msg.sender_id, msg.created_at_ms
FROM supertag_v2_mailbox_messages m
JOIN supertag_v2_m117_orphans o ON o.post_id = m.workstream_post_id
JOIN supertag_v2_messages msg ON msg.message_id = o.post_id
WHERE m.origin = 2 AND m.recipient_tag_id <> msg.sender_id;

-- 4. Direct messages: one conversation per pair of Tags, numbered in delivery order.
CREATE TEMPORARY TABLE supertag_v2_m117_direct AS
SELECT pair.message_id, pair.direct_key,
       ROW_NUMBER() OVER (PARTITION BY pair.direct_key ORDER BY pair.delivery_order) AS seq
FROM (SELECT message_id, delivery_order,
             't:' || MIN(sender_tag_id, recipient_tag_id) || char(10) || 't:' ||
             MAX(sender_tag_id, recipient_tag_id) AS direct_key
      FROM supertag_v2_mailbox_messages WHERE origin = 1) pair;
INSERT INTO supertag_v2_conversations (conversation_id, kind, direct_key, next_seq, created_at_ms)
SELECT 'direct/' || lower(hex(randomblob(16))), 1, d.direct_key, COUNT(*) + 1, MIN(m.created_at_ms)
FROM supertag_v2_m117_direct d
JOIN supertag_v2_mailbox_messages m ON m.message_id = d.message_id
GROUP BY d.direct_key;
INSERT INTO supertag_v2_messages
    (conversation_id, seq, message_id, sender_kind, sender_id, kind, text, hops, source_task_id,
     origin_task_id, objective_id, created_at_ms)
SELECT c.conversation_id, d.seq, m.message_id, 1, m.sender_tag_id,
       CASE WHEN EXISTS (SELECT 1 FROM supertag_v2_commit_reviews r WHERE r.request_id = m.message_id)
            THEN 6 ELSE 1 END,
       m.text, m.hops, m.source_task_id, m.source_task_id, m.objective_id, m.created_at_ms
FROM supertag_v2_m117_direct d
JOIN supertag_v2_mailbox_messages m ON m.message_id = d.message_id
JOIN supertag_v2_conversations c ON c.direct_key = d.direct_key;
INSERT INTO supertag_v2_message_addressees (conversation_id, seq, tag_id, sender_tag_id, created_at_ms)
SELECT c.conversation_id, d.seq, m.recipient_tag_id, m.sender_tag_id, m.created_at_ms
FROM supertag_v2_m117_direct d
JOIN supertag_v2_mailbox_messages m ON m.message_id = d.message_id
JOIN supertag_v2_conversations c ON c.direct_key = d.direct_key;

-- 5. Delivery state becomes wakes. Every Mailbox row, direct or an addressed copy, maps to the
-- message it delivered.
CREATE TEMPORARY TABLE supertag_v2_m117_delivery AS
SELECT m.recipient_tag_id AS tag_id, msg.conversation_id, msg.seq, m.task_id, m.hops,
       m.created_at_ms, m.origin, CASE WHEN msg.kind = 6 THEN 1 ELSE 0 END AS review
FROM supertag_v2_mailbox_messages m
JOIN supertag_v2_messages msg
  ON msg.message_id = CASE WHEN m.origin = 1 THEN m.message_id ELSE m.workstream_post_id END;
-- One wake per inbox Task and conversation for delivered rows, and one pending wake per Tag and
-- conversation for the rest, due now.
CREATE TEMPORARY TABLE supertag_v2_m117_wakes AS
SELECT tag_id, conversation_id, task_id,
       CASE WHEN MIN(origin) = 1 THEN 1 ELSE 2 END + CASE WHEN MAX(review) = 1 THEN 16 ELSE 0 END
           AS reasons,
       CASE WHEN MAX(review) = 1 THEN 2 ELSE 1 END AS priority,
       MIN(seq) AS first_seq, MAX(seq) AS last_seq, MAX(hops) AS hops,
       MIN(created_at_ms) AS created_at_ms, MAX(created_at_ms) AS bound_at_ms
FROM supertag_v2_m117_delivery
GROUP BY tag_id, conversation_id, task_id;
INSERT INTO supertag_v2_wakes
    (wake_id, tag_id, conversation_id, reasons, priority, first_seq, last_seq, hops,
     origin_task_id, objective_id, not_before_ms, created_at_ms, task_id, through_seq, bound_at_ms)
SELECT lower(hex(randomblob(16))), w.tag_id, w.conversation_id, w.reasons, w.priority,
       w.first_seq, w.last_seq, w.hops, first.origin_task_id, first.objective_id, 0,
       w.created_at_ms, w.task_id,
       CASE WHEN w.task_id IS NULL THEN NULL ELSE w.last_seq END,
       CASE WHEN w.task_id IS NULL THEN NULL ELSE w.bound_at_ms END
FROM supertag_v2_m117_wakes w
JOIN supertag_v2_messages first ON first.conversation_id = w.conversation_id
    AND first.seq = w.first_seq;

-- 6. Members. A Tag's position in a direct conversation stops before its first pending message;
-- its mention count is its pending messages. Old posts were pull-only, so a channel member starts
-- at the channel's latest post and counts only the pending posts addressed to it.
INSERT INTO supertag_v2_conversation_members
    (conversation_id, member_kind, member_id, read_seq, delivered_seq, mention_count, joined_at_ms)
SELECT c.conversation_id, 1, x.tag_id,
       COALESCE(p.first_pending - 1, c.next_seq - 1), COALESCE(p.first_pending - 1, c.next_seq - 1),
       COALESCE(p.pending, 0), c.created_at_ms
FROM (SELECT d.direct_key, m.sender_tag_id AS tag_id
      FROM supertag_v2_m117_direct d JOIN supertag_v2_mailbox_messages m ON m.message_id = d.message_id
      UNION
      SELECT d.direct_key, m.recipient_tag_id
      FROM supertag_v2_m117_direct d JOIN supertag_v2_mailbox_messages m ON m.message_id = d.message_id) x
JOIN supertag_v2_conversations c ON c.direct_key = x.direct_key
LEFT JOIN (SELECT tag_id, conversation_id, MIN(seq) AS first_pending, COUNT(*) AS pending
           FROM supertag_v2_m117_delivery WHERE task_id IS NULL
           GROUP BY tag_id, conversation_id) p
  ON p.tag_id = x.tag_id AND p.conversation_id = c.conversation_id;
INSERT INTO supertag_v2_conversation_members
    (conversation_id, member_kind, member_id, read_seq, delivered_seq, mention_count, joined_at_ms)
SELECT c.conversation_id, 1, tm.tag_id, c.next_seq - 1, c.next_seq - 1,
       (SELECT COUNT(*) FROM supertag_v2_m117_delivery d
        WHERE d.tag_id = tm.tag_id AND d.conversation_id = c.conversation_id AND d.task_id IS NULL),
       c.created_at_ms
FROM supertag_v2_team_members tm
JOIN supertag_v2_conversations c ON c.kind = 2 AND c.team_id = tm.team_id;

-- 7. Operation receipts. A verdict's receipt already names its review request message.
INSERT INTO supertag_v2_message_operations (scope, scope_id, operation_id, request_digest, message_id)
SELECT 1, source_task_id, operation_id, request_digest, message_id
FROM supertag_v2_mailbox_send_operations;
INSERT INTO supertag_v2_message_operations (scope, scope_id, operation_id, request_digest, message_id)
SELECT 2, source_task_id, operation_id, request_digest, post_id
FROM supertag_v2_workstream_operations;

DROP TABLE supertag_v2_m117_wakes;
DROP TABLE supertag_v2_m117_delivery;
DROP TABLE supertag_v2_m117_direct;
DROP TABLE supertag_v2_m117_orphans;

-- The watch feed announces a Tag's direct message (WatchKind 9, Mailbox message), one notice per
-- recipient, and a channel message as a Workstream post (WatchKind 6). SQLite cannot change a
-- CHECK, so the table is rebuilt as in 0093. These triggers come after the copy, so migrated
-- messages announce nothing.
PRAGMA legacy_alter_table = ON;
CREATE TABLE supertag_v2_watch_notices_next (
    position BIGINT PRIMARY KEY CHECK (position > 0),
    kind BIGINT NOT NULL CHECK (kind BETWEEN 1 AND 9),
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

CREATE TRIGGER supertag_v2_watch_channel_message AFTER INSERT ON supertag_v2_messages
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 6, 1, NEW.message_id, '', '', '', COALESCE(c.team_id, ''), '', ''
        FROM supertag_v2_conversations c
        WHERE c.conversation_id = NEW.conversation_id AND c.kind = 2;
END;
CREATE TRIGGER supertag_v2_watch_mailbox_message AFTER INSERT ON supertag_v2_message_addressees
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 9, 1, m.message_id, NEW.tag_id, '', COALESCE(m.objective_id, ''), '', '', ''
        FROM supertag_v2_messages m
        JOIN supertag_v2_conversations c ON c.conversation_id = m.conversation_id AND c.kind = 1
        WHERE m.conversation_id = NEW.conversation_id AND m.seq = NEW.seq;
END;

UPDATE supertag_v2_schema SET version=117 WHERE version=116;
