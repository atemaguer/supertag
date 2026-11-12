CREATE TABLE supertag_v2_commit_reviews (
    request_id TEXT PRIMARY KEY REFERENCES supertag_v2_mailbox_messages(message_id),
    objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
    requester_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    reviewer_tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    source_task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
    workspace_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    delivery BLOB NOT NULL,
    requested_at_ms BIGINT NOT NULL,
    created_order BIGINT NOT NULL UNIQUE,
    decision BIGINT CHECK (decision IN (1, 2)),
    summary TEXT,
    verdict_task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    recorded_at_ms BIGINT,
    notice_task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    notice_retry_at_ms BIGINT NOT NULL DEFAULT 0,
    CHECK (requester_tag_id <> reviewer_tag_id),
    CHECK ((decision IS NULL AND summary IS NULL AND verdict_task_id IS NULL AND recorded_at_ms IS NULL AND notice_task_id IS NULL)
        OR (decision IS NOT NULL AND summary IS NOT NULL AND verdict_task_id IS NOT NULL AND recorded_at_ms IS NOT NULL))
);
CREATE INDEX supertag_v2_commit_reviews_objective ON supertag_v2_commit_reviews(objective_id,created_order);
CREATE INDEX supertag_v2_commit_reviews_pending ON supertag_v2_commit_reviews(notice_task_id,created_order);
UPDATE supertag_v2_schema SET version=30 WHERE version=29;
