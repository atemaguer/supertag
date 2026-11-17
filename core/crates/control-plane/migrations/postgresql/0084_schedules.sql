-- A Schedule wakes one Tag later, once (`at_ms`) or on a cron recurrence in an IANA time zone.
-- When due, the maintenance sweep queues an ordinary Task in the Schedule's Session and records
-- the fire; it never starts a run. `audience_principal` is set when the Schedule fires in that
-- principal's conversation with the Tag, which resolves to the conversation's latest Session at
-- fire time. States: 1 staged (its turn has not finished), 2 active, 3 paused, 4 done, 5 cancelled.
CREATE TABLE supertag_v2_schedules (
    schedule_id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES supertag_v2_tags(tag_id),
    session_id TEXT NOT NULL,
    audience_principal TEXT,
    note TEXT NOT NULL,
    at_ms BIGINT,
    cron TEXT,
    time_zone TEXT,
    state SMALLINT NOT NULL CHECK (state BETWEEN 1 AND 5),
    next_due_at_ms BIGINT,
    created_by TEXT NOT NULL,
    origin_task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    origin_attempt_id TEXT,
    objective_id TEXT REFERENCES supertag_v2_objectives(objective_id),
    fire_count BIGINT NOT NULL DEFAULT 0,
    missed_count BIGINT NOT NULL DEFAULT 0,
    last_task_id TEXT REFERENCES supertag_v2_tasks(task_id),
    last_fired_at_ms BIGINT,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    CHECK ((at_ms IS NULL) <> (cron IS NULL)),
    CHECK ((cron IS NULL) = (time_zone IS NULL))
);
CREATE INDEX supertag_v2_schedules_due ON supertag_v2_schedules (state, next_due_at_ms);
CREATE INDEX supertag_v2_schedules_tag ON supertag_v2_schedules (tag_id, state);
CREATE INDEX supertag_v2_schedules_origin ON supertag_v2_schedules (origin_attempt_id);
CREATE INDEX supertag_v2_schedules_objective ON supertag_v2_schedules (objective_id);

-- One row per due occurrence. `task_id` is NULL when the occurrence was coalesced into a turn
-- that was still queued.
CREATE TABLE supertag_v2_schedule_fires (
    schedule_id TEXT NOT NULL REFERENCES supertag_v2_schedules(schedule_id),
    due_at_ms BIGINT NOT NULL,
    task_id TEXT UNIQUE REFERENCES supertag_v2_tasks(task_id),
    fired_at_ms BIGINT NOT NULL,
    PRIMARY KEY (schedule_id, due_at_ms)
);

-- Exact replay of a create by its operation ID.
CREATE TABLE supertag_v2_schedule_receipts (
    principal TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    schedule_id TEXT NOT NULL,
    PRIMARY KEY (principal, operation_id)
);

UPDATE supertag_v2_schema SET version=84 WHERE version=83;
