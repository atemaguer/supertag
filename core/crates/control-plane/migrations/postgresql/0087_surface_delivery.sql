-- A refused surface message is recorded without a Task: its receipts replay as answered, and its
-- one in-thread notice is a reply keyed by the refused message rather than by a Task.
ALTER TABLE supertag_v2_slack_messages ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE supertag_v2_slack_messages ADD COLUMN refusal TEXT;
ALTER TABLE supertag_v2_slack_messages ADD CHECK ((task_id IS NULL) <> (refusal IS NULL));
ALTER TABLE supertag_v2_slack_events ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE supertag_v2_slack_events ADD COLUMN refusal TEXT;
ALTER TABLE supertag_v2_slack_events ADD CHECK ((task_id IS NULL) <> (refusal IS NULL));
ALTER TABLE supertag_v2_lark_messages ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE supertag_v2_lark_messages ADD COLUMN refusal TEXT;
ALTER TABLE supertag_v2_lark_messages ADD CHECK ((task_id IS NULL) <> (refusal IS NULL));
ALTER TABLE supertag_v2_lark_events ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE supertag_v2_lark_events ADD COLUMN refusal TEXT;
ALTER TABLE supertag_v2_lark_events ADD CHECK ((task_id IS NULL) <> (refusal IS NULL));
ALTER TABLE supertag_v2_microsoft_teams_activities ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE supertag_v2_microsoft_teams_activities ADD COLUMN refusal TEXT;
ALTER TABLE supertag_v2_microsoft_teams_activities ADD CHECK ((task_id IS NULL) <> (refusal IS NULL));

-- A reply answers a Task, or is a notice the Control Plane posts once under its own key.
ALTER TABLE supertag_v2_replies ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE supertag_v2_replies ADD COLUMN notice_key TEXT UNIQUE;
ALTER TABLE supertag_v2_replies ADD CHECK ((task_id IS NULL) <> (notice_key IS NULL));

-- A message joined into another Task's Attempt when that Attempt was claimed. The Task that
-- answers it reads its joined messages again on every later claim, so the set never changes.
ALTER TABLE supertag_v2_live_inputs ADD COLUMN joined_at_claim BIGINT NOT NULL DEFAULT 0;
CREATE INDEX supertag_v2_live_inputs_task ON supertag_v2_live_inputs(task_id, joined_at_claim);

UPDATE supertag_v2_schema SET version=87 WHERE version=86;
