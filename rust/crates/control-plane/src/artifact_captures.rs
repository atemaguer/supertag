use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{
    artifacts::{MAX_ARTIFACT_FILES, validate_artifact_path, validate_capture_manifest},
    v2::*,
};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, HostAuthority, Store, StoreError,
    conversations::task_access_in,
    policy::{decode, operator},
    store::{Result, invalid, lease_is_live, name, owned, task_row},
};

impl Store {
    pub async fn reserve_artifact_capture(
        &self,
        host: &HostAuthority,
        input: &CommitArtifactCaptureRequest,
    ) -> Result<CapturedArtifact> {
        self.record_artifact_capture(host, input, false).await
    }

    pub async fn commit_artifact_capture(
        &self,
        host: &HostAuthority,
        input: &CommitArtifactCaptureRequest,
    ) -> Result<CapturedArtifact> {
        self.record_artifact_capture(host, input, true).await
    }

    async fn record_artifact_capture(
        &self,
        host: &HostAuthority,
        input: &CommitArtifactCaptureRequest,
        commit: bool,
    ) -> Result<CapturedArtifact> {
        let byte_length =
            validate_capture_manifest(input).map_err(|error| invalid(error.message()))?;
        let mut canonical = input.clone();
        let attempt = canonical.attempt.take().expect("validated Attempt");
        canonical
            .files
            .sort_unstable_by(|left, right| left.path.cmp(&right.path));
        let digest = format!("{:x}", Sha256::digest(canonical.encode_to_vec()));
        let (mut tx, order) = self.write().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let now = self.execution_now_ms();
        let prior = sqlx::query(
            "SELECT request_digest,payload,committed_order FROM supertag_v2_artifact_captures
             WHERE attempt_id=$1 AND operation_id=$2 AND task_id=$3",
        )
        .bind(&attempt.attempt_id)
        .bind(&canonical.operation_id)
        .bind(&attempt.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "artifact capture operation was used with a different manifest".into(),
                ));
            }
            if prior
                .try_get::<Option<i64>, _>("committed_order")?
                .is_none()
            {
                running(&row, now)?;
                if commit {
                    sqlx::query(
                        "UPDATE supertag_v2_artifact_captures SET committed_order=$1
                         WHERE attempt_id=$2 AND operation_id=$3",
                    )
                    .bind(order)
                    .bind(&attempt.attempt_id)
                    .bind(&canonical.operation_id)
                    .execute(&mut *tx)
                    .await?;
                    tx.commit().await?;
                    return capture_row(&prior);
                }
            }
            tx.rollback().await?;
            return capture_row(&prior);
        }
        if commit {
            return Err(StoreError::FailedPrecondition(
                "artifact capture reservation is missing".into(),
            ));
        }
        running(&row, now)?;
        let task = task_row(&row)?;
        let permitted = if canonical.managed_task_output {
            task.workspace.is_some()
                && task.attempt_execution.as_ref().is_some_and(|execution| {
                    !execution.remote_file_workspace
                        && matches!(
                            execution.harness_kind(),
                            HarnessKind::Codex | HarnessKind::ClaudeCode
                        )
                })
                && task
                    .allowed_actions
                    .iter()
                    .any(|action| action == "files:write")
        } else {
            task.allowed_actions
                .iter()
                .any(|action| action == "files:read")
        };
        if !permitted {
            return Err(StoreError::PermissionDenied);
        }
        let objective_id = sqlx::query_scalar(
            "SELECT objective_id FROM supertag_v2_task_audience WHERE task_id=$1 AND objective_id<>''",
        )
        .bind(&task.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        let artifact_id = Uuid::new_v4().to_string();
        let artifact = CapturedArtifact {
            summary: Some(ArtifactSummary {
                artifact_id: artifact_id.clone(),
                description: canonical.description,
                producer: Some(ArtifactProducer {
                    task_id: task.task_id,
                    attempt_id: attempt.attempt_id.clone(),
                    tag_id: task.tag_id,
                    session_id: task.session_id,
                    objective_id,
                    harness_kind: task
                        .attempt_execution
                        .map_or(task.harness_kind, |value| value.harness_kind),
                    native_session_id: canonical.native_session_id,
                }),
                file_count: canonical.files.len() as u32,
                byte_length,
                captured_at_ms: now,
            }),
            files: canonical.files,
        };
        sqlx::query(
            "INSERT INTO supertag_v2_artifact_captures
               (artifact_id,task_id,attempt_id,operation_id,request_digest,payload)
             VALUES ($1,$2,$3,$4,$5,$6)",
        )
        .bind(artifact_id)
        .bind(&attempt.task_id)
        .bind(&attempt.attempt_id)
        .bind(&canonical.operation_id)
        .bind(digest)
        .bind(artifact.encode_to_vec())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(artifact)
    }

    pub async fn get_captured_artifact(
        &self,
        principal: &str,
        artifact_id: &str,
    ) -> Result<CapturedArtifact> {
        operator(principal)?;
        name("artifact ID", artifact_id)?;
        let mut tx = self.pool.begin().await?;
        let missing = || StoreError::NotFound("artifact was not found".into());
        let row = sqlx::query(
            "SELECT task_id,payload FROM supertag_v2_artifact_captures
             WHERE artifact_id=$1 AND committed_order IS NOT NULL",
        )
        .bind(artifact_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(missing)?;
        if !task_access_in(&mut tx, principal, &row.try_get::<String, _>("task_id")?).await? {
            return Err(missing());
        }
        let artifact = capture_row(&row)?;
        tx.commit().await?;
        Ok(artifact)
    }

    pub async fn list_captured_artifacts(
        &self,
        principal: &str,
        input: &ListCapturedArtifactsRequest,
    ) -> Result<ListCapturedArtifactsResponse> {
        operator(principal)?;
        name("Task ID", &input.task_id)?;
        let before =
            i64::try_from(input.before_order).map_err(|_| invalid("invalid artifact cursor"))?;
        let limit = match input.limit {
            0 => 50,
            1..=100 => input.limit,
            _ => return Err(invalid("artifact page limit must be at most 100")),
        };
        let mut tx = self.pool.begin().await?;
        if !task_access_in(&mut tx, principal, &input.task_id).await? {
            return Err(StoreError::NotFound("Task was not found".into()));
        }
        let rows = sqlx::query(
            "SELECT payload,committed_order FROM supertag_v2_artifact_captures
             WHERE task_id=$1 AND committed_order IS NOT NULL AND ($2=0 OR committed_order<$2)
             ORDER BY committed_order DESC LIMIT $3",
        )
        .bind(&input.task_id)
        .bind(before)
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await?;
        let artifacts = rows
            .iter()
            .take(limit as usize)
            .map(|row| {
                capture_row(row)?.summary.ok_or_else(|| {
                    StoreError::FailedPrecondition("stored artifact summary is missing".into())
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let next_before_order = if rows.len() > limit as usize {
            rows[limit as usize - 1].try_get::<i64, _>("committed_order")? as u64
        } else {
            0
        };
        tx.commit().await?;
        Ok(ListCapturedArtifactsResponse {
            artifacts,
            next_before_order,
        })
    }
}

fn capture_row(row: &AnyRow) -> Result<CapturedArtifact> {
    decode(&row.try_get::<Vec<u8>, _>("payload")?)
}

#[derive(Message)]
struct SubmittedArtifacts {
    #[prost(message, repeated, tag = "1")]
    selections: Vec<ArtifactSelection>,
}

pub(crate) fn submitted_from_row(row: &AnyRow) -> Result<Vec<ArtifactSelection>> {
    let stored: Option<Vec<u8>> = row.try_get("result_artifacts")?;
    Ok(stored
        .as_deref()
        .map(decode::<SubmittedArtifacts>)
        .transpose()?
        .map_or_else(Vec::new, |result| result.selections))
}

pub(crate) fn normalize_submissions(input: &[ArtifactSelection]) -> Result<Vec<ArtifactSelection>> {
    if input.len() > 100 {
        return Err(invalid("a Task can submit at most 100 artifacts"));
    }
    let mut selections = input.to_vec();
    selections.sort_unstable_by(|left, right| left.artifact_id.cmp(&right.artifact_id));
    if selections
        .windows(2)
        .any(|pair| pair[0].artifact_id == pair[1].artifact_id)
    {
        return Err(invalid("submitted artifacts must be unique"));
    }
    for selection in &mut selections {
        name("artifact ID", &selection.artifact_id)?;
        if !(1..=MAX_ARTIFACT_FILES).contains(&selection.paths.len()) {
            return Err(invalid(
                "submitted artifact must select between 1 and 100 paths",
            ));
        }
        for path in &selection.paths {
            validate_artifact_path(path).map_err(|error| invalid(error.message()))?;
        }
        selection.paths.sort_unstable();
        if selection.paths.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(invalid("submitted artifact paths must be unique"));
        }
    }
    Ok(selections)
}

pub(crate) async fn submit_in(
    tx: &mut Transaction<'_, Any>,
    input: &FinishTaskRequest,
) -> Result<()> {
    let selections = normalize_submissions(&input.artifacts)?;
    for selection in &selections {
        let row = sqlx::query(
            "SELECT payload FROM supertag_v2_artifact_captures
             WHERE artifact_id=$1 AND task_id=$2 AND attempt_id=$3 AND committed_order IS NOT NULL",
        )
        .bind(&selection.artifact_id)
        .bind(&input.task_id)
        .bind(&input.attempt_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| invalid("submitted artifact must be committed by this Task Attempt"))?;
        let artifact = capture_row(&row)?;
        if selection
            .paths
            .iter()
            .any(|path| !artifact.files.iter().any(|entry| &entry.path == path))
        {
            return Err(invalid("submitted artifact path does not exist"));
        }
    }
    sqlx::query("UPDATE supertag_v2_tasks SET result_artifacts=$1 WHERE task_id=$2")
        .bind(SubmittedArtifacts { selections }.encode_to_vec())
        .bind(&input.task_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn running(row: &AnyRow, now: i64) -> Result<()> {
    if row.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(row, now)? {
        return Err(StoreError::FailedPrecondition(
            "artifact capture requires a running Attempt with current authority".into(),
        ));
    }
    Ok(())
}

#[tonic::async_trait]
impl artifact_directory_server::ArtifactDirectory for ControlPlane {
    async fn reserve_capture(
        &self,
        request: Request<CommitArtifactCaptureRequest>,
    ) -> std::result::Result<Response<CapturedArtifact>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .reserve_artifact_capture(&host, request.get_ref())
                .await?,
        ))
    }

    async fn commit_capture(
        &self,
        request: Request<CommitArtifactCaptureRequest>,
    ) -> std::result::Result<Response<CapturedArtifact>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .commit_artifact_capture(&host, request.get_ref())
                .await?,
        ))
    }

    async fn get(
        &self,
        request: Request<GetCapturedArtifactRequest>,
    ) -> std::result::Result<Response<CapturedArtifact>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_captured_artifact(&principal, &request.get_ref().artifact_id)
                .await?,
        ))
    }

    async fn list(
        &self,
        request: Request<ListCapturedArtifactsRequest>,
    ) -> std::result::Result<Response<ListCapturedArtifactsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_captured_artifacts(&principal, request.get_ref())
                .await?,
        ))
    }
}
