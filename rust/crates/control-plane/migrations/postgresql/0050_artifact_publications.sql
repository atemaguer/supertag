CREATE TABLE supertag_v2_artifact_publications (
 publication_id TEXT PRIMARY KEY, source_objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
 artifact_id TEXT NOT NULL REFERENCES supertag_v2_artifact_captures(artifact_id),
 request_digest TEXT NOT NULL, payload BYTEA NOT NULL, created_order BIGINT NOT NULL UNIQUE
);
CREATE TABLE supertag_v2_artifact_publication_audience (
 publication_id TEXT NOT NULL REFERENCES supertag_v2_artifact_publications(publication_id),
 objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
 PRIMARY KEY(publication_id,objective_id)
);
CREATE TABLE supertag_v2_artifact_consumptions (
 consumption_id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES supertag_v2_artifact_publications(publication_id),
 objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
 request_digest TEXT NOT NULL, payload BYTEA NOT NULL, created_order BIGINT NOT NULL UNIQUE,
 UNIQUE(publication_id,objective_id)
);
CREATE TABLE supertag_v2_artifact_approval_audit (
 approval_type TEXT NOT NULL, approval_id TEXT NOT NULL, revision BIGINT NOT NULL,
 payload BYTEA NOT NULL, PRIMARY KEY(approval_type,approval_id,revision)
);
CREATE TABLE supertag_v2_artifact_review_evidence (
 task_id TEXT NOT NULL REFERENCES supertag_v2_tasks(task_id), attempt_id TEXT NOT NULL,
 objective_id TEXT NOT NULL REFERENCES supertag_v2_objectives(objective_id),
 objective_revision BIGINT NOT NULL, approved BIGINT NOT NULL,
 actor TEXT NOT NULL, recorded_at_ms BIGINT NOT NULL, selections BYTEA NOT NULL,
 PRIMARY KEY(task_id,attempt_id,objective_revision)
);
CREATE INDEX supertag_v2_artifact_publications_source ON supertag_v2_artifact_publications(source_objective_id,created_order);
CREATE INDEX supertag_v2_artifact_publication_audience_objective ON supertag_v2_artifact_publication_audience(objective_id,publication_id);
CREATE INDEX supertag_v2_artifact_consumptions_objective ON supertag_v2_artifact_consumptions(objective_id,created_order);
UPDATE supertag_v2_schema SET version=50 WHERE version=49;
