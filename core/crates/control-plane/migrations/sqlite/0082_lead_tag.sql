-- The Control Plane's lead Tag: the default Tag `supertag init` creates, which clients show first.
-- At most one active Tag is the lead.
ALTER TABLE supertag_v2_tags ADD COLUMN lead BIGINT NOT NULL DEFAULT 0 CHECK (lead IN (0, 1));
CREATE UNIQUE INDEX supertag_v2_tags_active_lead
    ON supertag_v2_tags(lead) WHERE lead = 1 AND retired_at_ms IS NULL;
UPDATE supertag_v2_schema SET version=82 WHERE version=81;
