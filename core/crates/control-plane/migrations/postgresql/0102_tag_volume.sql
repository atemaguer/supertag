-- The Volume that keeps a Tag's work beyond any one Worker Host; NULL for none.
ALTER TABLE supertag_v2_tags ADD COLUMN volume TEXT;
-- The Control Plane no longer copies artifacts into Volumes; only captures keep copies there.
DELETE FROM supertag_v2_artifact_volume_copies WHERE principal <> 'capture';

UPDATE supertag_v2_schema SET version=102 WHERE version=101;
