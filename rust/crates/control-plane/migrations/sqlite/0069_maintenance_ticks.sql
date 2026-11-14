-- Control Plane replicas sharing one database claim each periodic maintenance pass here, so one
-- replica runs it per tick and any replica takes over when the last claimant stops.
CREATE TABLE supertag_v2_maintenance_ticks (
    singleton BIGINT PRIMARY KEY CHECK (singleton = 1),
    due_at_ms BIGINT NOT NULL
);
INSERT INTO supertag_v2_maintenance_ticks VALUES (1, 0);
UPDATE supertag_v2_schema SET version=69 WHERE version=68;
