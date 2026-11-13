ALTER TABLE supertag_v2_artifact_volume_copies ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
CREATE INDEX supertag_v2_artifact_verified_file_locations
ON supertag_v2_artifact_volume_copies(artifact_id,file_path,volume_id,created_order)
WHERE state=2;
UPDATE supertag_v2_schema SET version=52 WHERE version=51;
