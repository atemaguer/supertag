-- The Worker Host that holds a Workspace delivery's patch and bundle. The Control Plane stores no
-- delivery bytes; it relays them from this host to authorized readers.
ALTER TABLE supertag_v2_workspace_deliveries ADD COLUMN holder_host_id TEXT NOT NULL DEFAULT '';
-- Readers resolve the holder from the exact reference they were authorized for.
CREATE INDEX supertag_v2_workspace_deliveries_reference ON supertag_v2_workspace_deliveries(reference);
UPDATE supertag_v2_schema SET version=79 WHERE version=78;
