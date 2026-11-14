CREATE TABLE supertag_v2_microsoft_teams_routes (
    account_id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id)
);
CREATE TABLE supertag_v2_microsoft_teams_activities (
    account_id TEXT NOT NULL REFERENCES supertag_v2_microsoft_teams_routes(account_id),
    conversation_id TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    root_activity_id TEXT NOT NULL,
    service_url TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES supertag_v2_tasks(task_id),
    PRIMARY KEY (account_id, conversation_id, activity_id)
);
UPDATE supertag_v2_schema SET version = 17 WHERE version = 16;
