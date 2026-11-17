-- A refused surface message is recorded without a Task: its receipts replay as answered, and its
-- one in-thread notice is a reply keyed by the refused message rather than by a Task.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE supertag_v2_slack_messages_saved AS SELECT * FROM supertag_v2_slack_messages;
DROP TABLE supertag_v2_slack_messages;
CREATE TABLE supertag_v2_slack_messages (
    account_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    refusal TEXT,
    CHECK ((task_id IS NULL) <> (refusal IS NULL)),
    PRIMARY KEY (account_id, team_id, channel_id, message_ts)
);
INSERT INTO supertag_v2_slack_messages (account_id, team_id, channel_id, message_ts, request_digest, task_id)
SELECT account_id, team_id, channel_id, message_ts, request_digest, task_id FROM supertag_v2_slack_messages_saved;
DROP TABLE supertag_v2_slack_messages_saved;

CREATE TABLE supertag_v2_slack_events_saved AS SELECT * FROM supertag_v2_slack_events;
DROP TABLE supertag_v2_slack_events;
CREATE TABLE supertag_v2_slack_events (
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    refusal TEXT,
    CHECK ((task_id IS NULL) <> (refusal IS NULL)),
    PRIMARY KEY (account_id, event_id)
);
INSERT INTO supertag_v2_slack_events (account_id, event_id, request_digest, task_id)
SELECT account_id, event_id, request_digest, task_id FROM supertag_v2_slack_events_saved;
DROP TABLE supertag_v2_slack_events_saved;

CREATE TABLE supertag_v2_lark_messages_saved AS SELECT * FROM supertag_v2_lark_messages;
DROP TABLE supertag_v2_lark_messages;
CREATE TABLE supertag_v2_lark_messages (
    account_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    refusal TEXT,
    CHECK ((task_id IS NULL) <> (refusal IS NULL)),
    PRIMARY KEY (account_id, chat_id, message_id)
);
INSERT INTO supertag_v2_lark_messages (account_id, chat_id, message_id, request_digest, task_id)
SELECT account_id, chat_id, message_id, request_digest, task_id FROM supertag_v2_lark_messages_saved;
DROP TABLE supertag_v2_lark_messages_saved;

CREATE TABLE supertag_v2_lark_events_saved AS SELECT * FROM supertag_v2_lark_events;
DROP TABLE supertag_v2_lark_events;
CREATE TABLE supertag_v2_lark_events (
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    refusal TEXT,
    CHECK ((task_id IS NULL) <> (refusal IS NULL)),
    PRIMARY KEY (account_id, event_id)
);
INSERT INTO supertag_v2_lark_events (account_id, event_id, request_digest, task_id)
SELECT account_id, event_id, request_digest, task_id FROM supertag_v2_lark_events_saved;
DROP TABLE supertag_v2_lark_events_saved;

CREATE TABLE supertag_v2_microsoft_teams_activities_saved AS
SELECT * FROM supertag_v2_microsoft_teams_activities;
DROP TABLE supertag_v2_microsoft_teams_activities;
CREATE TABLE supertag_v2_microsoft_teams_activities (
    account_id TEXT NOT NULL REFERENCES supertag_v2_microsoft_teams_routes(account_id),
    conversation_id TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    root_activity_id TEXT NOT NULL,
    service_url TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    refusal TEXT,
    CHECK ((task_id IS NULL) <> (refusal IS NULL)),
    PRIMARY KEY (account_id, conversation_id, activity_id)
);
INSERT INTO supertag_v2_microsoft_teams_activities
    (account_id, conversation_id, activity_id, root_activity_id, service_url, request_digest, task_id)
SELECT account_id, conversation_id, activity_id, root_activity_id, service_url, request_digest, task_id
FROM supertag_v2_microsoft_teams_activities_saved;
DROP TABLE supertag_v2_microsoft_teams_activities_saved;

-- A reply answers a Task, or is a notice the Control Plane posts once under its own key.
CREATE TABLE supertag_v2_replies_saved AS SELECT * FROM supertag_v2_replies;
DROP TABLE supertag_v2_replies;
CREATE TABLE supertag_v2_replies (
    reply_id TEXT PRIMARY KEY,
    task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    thread_id TEXT,
    text TEXT NOT NULL,
    state BIGINT NOT NULL,
    provider_receipt TEXT,
    lease_token TEXT,
    ready_order BIGINT NOT NULL UNIQUE,
    lease_expires_at_ms BIGINT,
    expired_claim BIGINT NOT NULL DEFAULT 0,
    notice_key TEXT UNIQUE,
    CHECK ((task_id IS NULL) <> (notice_key IS NULL))
);
INSERT INTO supertag_v2_replies
    (reply_id, task_id, account_id, conversation_id, thread_id, text, state, provider_receipt,
     lease_token, ready_order, lease_expires_at_ms, expired_claim)
SELECT reply_id, task_id, account_id, conversation_id, thread_id, text, state, provider_receipt,
       lease_token, ready_order, lease_expires_at_ms, expired_claim
FROM supertag_v2_replies_saved;
DROP TABLE supertag_v2_replies_saved;
CREATE INDEX supertag_v2_replies_pending ON supertag_v2_replies(account_id, state, ready_order);
CREATE INDEX supertag_v2_replies_expiry ON supertag_v2_replies(state, lease_expires_at_ms);

-- A message joined into another Task's Attempt when that Attempt was claimed. The Task that
-- answers it reads its joined messages again on every later claim, so the set never changes.
ALTER TABLE supertag_v2_live_inputs ADD COLUMN joined_at_claim BIGINT NOT NULL DEFAULT 0;
CREATE INDEX supertag_v2_live_inputs_task ON supertag_v2_live_inputs(task_id, joined_at_claim);

UPDATE supertag_v2_schema SET version=87 WHERE version=86;
