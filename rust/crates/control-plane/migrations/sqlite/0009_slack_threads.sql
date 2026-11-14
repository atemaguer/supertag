-- Routing and both provider/logical-message receipts are committed with the Task.
CREATE TABLE supertag_v2_slack_threads (
    account_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    session_id TEXT NOT NULL,
    PRIMARY KEY (account_id, team_id, channel_id, thread_ts)
);
CREATE TABLE supertag_v2_slack_messages (
    account_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (account_id, team_id, channel_id, message_ts)
);
CREATE TABLE supertag_v2_slack_events (
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (account_id, event_id)
);
UPDATE supertag_v2_schema SET version = 9 WHERE version = 8;
