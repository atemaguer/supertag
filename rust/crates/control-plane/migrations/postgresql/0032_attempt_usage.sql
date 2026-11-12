-- Each native row is an immutable cumulative observation. Cost is optional evidence.
ALTER TABLE supertag_v2_native_usage ADD COLUMN total_tokens BIGINT CHECK(total_tokens >= 0);
ALTER TABLE supertag_v2_native_usage ADD COLUMN amount_minor BIGINT CHECK(amount_minor >= 0);
ALTER TABLE supertag_v2_native_usage ADD COLUMN currency TEXT;
ALTER TABLE supertag_v2_native_usage ADD COLUMN estimated BIGINT NOT NULL DEFAULT 0 CHECK(estimated IN (0,1));

CREATE INDEX supertag_v2_native_usage_task ON supertag_v2_native_usage(task_id,attempt_id,sequence);

-- Cost heads apply to every Task; sequence belongs only to the independent cost lane.
CREATE TABLE supertag_v2_attempt_usage (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id),
  sequence BIGINT NOT NULL DEFAULT 0 CHECK(sequence >= 0),
  amount_minor BIGINT CHECK(amount_minor >= 0),
  currency TEXT,
  measured_amount_minor BIGINT CHECK(measured_amount_minor >= 0),
  estimated BIGINT NOT NULL DEFAULT 0 CHECK(estimated IN (0,1)),
  CHECK((amount_minor IS NULL AND currency IS NULL) OR (amount_minor IS NOT NULL AND currency IS NOT NULL)),
  CHECK(estimated=0 OR amount_minor IS NOT NULL)
);
CREATE INDEX supertag_v2_attempt_usage_task ON supertag_v2_attempt_usage(task_id);
CREATE TABLE supertag_v2_attempt_usage_events (
  attempt_id TEXT NOT NULL REFERENCES supertag_v2_attempt_usage(attempt_id),
  sequence BIGINT NOT NULL CHECK(sequence > 0),
  request_digest TEXT NOT NULL,
  amount_minor BIGINT CHECK(amount_minor >= 0),
  currency TEXT,
  -- NULL only for older digest-only receipts; new unknown observations record false.
  estimated BIGINT CHECK(estimated IN (0,1)),
  PRIMARY KEY(attempt_id,sequence)
);
INSERT INTO supertag_v2_attempt_usage (attempt_id,task_id,sequence,amount_minor,currency,estimated)
  SELECT attempt_id,task_id,sequence,amount_minor,currency,estimated FROM supertag_v2_objective_usage;
UPDATE supertag_v2_attempt_usage SET measured_amount_minor=amount_minor WHERE estimated=0;
INSERT INTO supertag_v2_attempt_usage_events (attempt_id,sequence,request_digest)
  SELECT attempt_id,sequence,request_digest FROM supertag_v2_objective_usage_events;
INSERT INTO supertag_v2_attempt_usage (attempt_id,task_id)
  SELECT DISTINCT n.attempt_id,n.task_id FROM supertag_v2_native_usage n
  WHERE NOT EXISTS (SELECT 1 FROM supertag_v2_attempt_usage u WHERE u.attempt_id=n.attempt_id);
UPDATE supertag_v2_schema SET version=32 WHERE version=31;
