use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{v2::*, validate_workspace_delivery};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store, StoreError,
    store::{HostAuthority, Result, invalid, lease_is_live, name, owned},
};

impl Store {
    pub async fn get_workspace_continuation(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
    ) -> Result<Option<WorkspaceDeliveryReference>> {
        let mut tx = self.pool.begin().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        require_running(&task, self.execution_now_ms())?;
        workspace_from_row(&task)?.ok_or_else(|| invalid("Attempt has no workspace"))?;
        let delivery = continuation_in(&mut tx, &task).await?;
        tx.commit().await?;
        Ok(delivery)
    }

    pub async fn reserve_workspace_delivery(
        &self,
        host: &HostAuthority,
        input: &WorkspaceDeliveryRequest,
    ) -> Result<WorkspaceDeliveryReference> {
        self.record_workspace_delivery(host, input, false).await
    }

    pub async fn commit_workspace_delivery(
        &self,
        host: &HostAuthority,
        input: &WorkspaceDeliveryRequest,
    ) -> Result<WorkspaceDeliveryReference> {
        self.record_workspace_delivery(host, input, true).await
    }

    async fn record_workspace_delivery(
        &self,
        host: &HostAuthority,
        input: &WorkspaceDeliveryRequest,
        commit: bool,
    ) -> Result<WorkspaceDeliveryReference> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity required"))?;
        let reference = input
            .delivery
            .as_ref()
            .ok_or_else(|| invalid("workspace delivery required"))?;
        validate_workspace_delivery(reference).map_err(|error| invalid(error.message()))?;
        let delivery_id = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &attempt.task_id,
                &attempt.attempt_id
            ))?)
        );
        if reference.delivery_id != delivery_id {
            return Err(invalid("workspace delivery does not identify this Attempt"));
        }

        let (mut tx, _) = self.write().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let prior = sqlx::query("SELECT reference,committed_at_ms FROM supertag_v2_workspace_deliveries WHERE attempt_id=$1 AND task_id=$2")
            .bind(&attempt.attempt_id).bind(&attempt.task_id).fetch_optional(&mut *tx).await?;
        let now = self.execution_now_ms();
        if let Some(prior) = prior {
            if &decode_delivery(prior.try_get("reference")?)? != reference {
                return Err(StoreError::Conflict(
                    "Attempt already reserved a different workspace delivery".into(),
                ));
            }
            if commit
                && prior
                    .try_get::<Option<i64>, _>("committed_at_ms")?
                    .is_none()
            {
                require_running(&task, now)?;
                sqlx::query("UPDATE supertag_v2_workspace_deliveries SET committed_at_ms=$1 WHERE attempt_id=$2")
                    .bind(now).bind(&attempt.attempt_id).execute(&mut *tx).await?;
            } else if !commit {
                require_running(&task, now)?;
            }
        } else {
            require_running(&task, now)?;
            if commit {
                return Err(StoreError::FailedPrecondition(
                    "workspace delivery must be reserved first".into(),
                ));
            }
            let spec =
                workspace_from_row(&task)?.ok_or_else(|| invalid("Attempt has no workspace"))?;
            let previous = continuation_in(&mut tx, &task).await?;
            let start = previous
                .as_ref()
                .map_or(&spec.base_commit, |value| &value.head_commit);
            if reference.workspace_id != spec.workspace_id
                || reference.base_commit != spec.base_commit
                || &reference.start_commit != start
            {
                return Err(StoreError::FailedPrecondition(
                    "workspace delivery does not match the accepted pins".into(),
                ));
            }
            sqlx::query("INSERT INTO supertag_v2_workspace_deliveries (attempt_id,task_id,reference) VALUES ($1,$2,$3)")
                .bind(&attempt.attempt_id).bind(&attempt.task_id).bind(reference.encode_to_vec()).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(reference.clone())
    }

    pub async fn get_workspace_artifact(
        &self,
        input: &GetWorkspaceArtifactRequest,
    ) -> Result<WorkspaceDeliveryReference> {
        name("Task ID", &input.task_id)?;
        if !matches!(
            input.kind(),
            WorkspaceArtifactKind::Patch | WorkspaceArtifactKind::Bundle
        ) {
            return Err(invalid("workspace artifact kind required"));
        }
        let task = self.get_task(&input.task_id).await?;
        task.workspace_delivery
            .ok_or_else(|| StoreError::NotFound("Task has no published workspace delivery".into()))
    }
}

pub(crate) async fn finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &AnyRow,
    input: &FinishTaskRequest,
) -> Result<()> {
    let spec = workspace_from_row(task)?;
    let Some(reference) = input.workspace_delivery.as_ref() else {
        return if spec.is_some() {
            Err(StoreError::FailedPrecondition(
                "successful workspace Task requires durable delivery".into(),
            ))
        } else {
            Ok(())
        };
    };
    if spec.is_none() {
        return Err(invalid("Task has no workspace"));
    }
    let bytes: Option<Vec<u8>> = sqlx::query_scalar("SELECT reference FROM supertag_v2_workspace_deliveries WHERE attempt_id=$1 AND task_id=$2 AND committed_at_ms IS NOT NULL")
        .bind(&input.attempt_id).bind(&input.task_id).fetch_optional(&mut **tx).await?;
    let accepted = bytes.ok_or_else(|| {
        StoreError::FailedPrecondition("workspace delivery has not been committed".into())
    })?;
    if &decode_delivery(accepted)? != reference {
        return Err(StoreError::Conflict(
            "Finish named a different workspace delivery".into(),
        ));
    }
    sqlx::query("UPDATE supertag_v2_tasks SET workspace_delivery=$1 WHERE task_id=$2")
        .bind(reference.encode_to_vec())
        .bind(&input.task_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO supertag_v2_workspace_heads (tag_id,session_id,attempt_id) VALUES ($1,$2,$3) ON CONFLICT(tag_id,session_id) DO UPDATE SET attempt_id=excluded.attempt_id")
        .bind(task.try_get::<String,_>("tag_id")?)
        .bind(task.try_get::<String,_>("session_id")?)
        .bind(&input.attempt_id)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn continuation_in(
    tx: &mut Transaction<'_, Any>,
    task: &AnyRow,
) -> Result<Option<WorkspaceDeliveryReference>> {
    let bytes: Option<Vec<u8>> = sqlx::query_scalar("SELECT d.reference FROM supertag_v2_workspace_heads h JOIN supertag_v2_workspace_deliveries d ON h.attempt_id=d.attempt_id WHERE h.tag_id=$1 AND h.session_id=$2 AND d.committed_at_ms IS NOT NULL")
        .bind(task.try_get::<String,_>("tag_id")?)
        .bind(task.try_get::<String,_>("session_id")?)
        .fetch_optional(&mut **tx).await?;
    bytes.map(decode_delivery).transpose()
}

pub(crate) fn workspace_from_row(row: &AnyRow) -> Result<Option<WorkspaceSpec>> {
    let id: Option<String> = row.try_get("workspace_id")?;
    let base: Option<String> = row.try_get("workspace_base_commit")?;
    // Tag rows have no source pin: admission resolves their configured catalog.
    let bytes = match row.try_get::<Vec<u8>, _>("workspace_github_source") {
        Ok(bytes) => bytes,
        Err(sqlx::Error::ColumnNotFound(_)) => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let github_source = if bytes.is_empty() {
        None
    } else {
        Some(crate::policy::decode(&bytes)?)
    };
    match (id, base) {
        (Some(workspace_id), Some(base_commit)) => Ok(Some(WorkspaceSpec {
            workspace_id,
            base_commit,
            github_source,
        })),
        (None, None) => Ok(None),
        _ => Err(sqlx::Error::Protocol("incomplete stored workspace policy".into()).into()),
    }
}

pub(crate) fn delivery_from_row(row: &AnyRow) -> Result<Option<WorkspaceDeliveryReference>> {
    row.try_get::<Option<Vec<u8>>, _>("workspace_delivery")?
        .map(decode_delivery)
        .transpose()
}

fn decode_delivery(bytes: Vec<u8>) -> Result<WorkspaceDeliveryReference> {
    WorkspaceDeliveryReference::decode(bytes.as_slice())
        .map_err(|error| sqlx::Error::Decode(Box::new(error)).into())
}

fn require_running(row: &AnyRow, now: i64) -> Result<()> {
    if row.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(row, now)? {
        return Err(StoreError::FailedPrecondition(
            "Attempt is not running with current authority".into(),
        ));
    }
    Ok(())
}

#[tonic::async_trait]
impl workspace_directory_server::WorkspaceDirectory for ControlPlane {
    async fn get_source(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> std::result::Result<Response<GithubWorkspace>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .get_github_workspace_source(&host, request.get_ref())
                .await?,
        ))
    }

    async fn get_review_artifact(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> std::result::Result<Response<WorkspaceDeliveryReference>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .get_review_artifact(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn get_continuation(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> std::result::Result<Response<WorkspaceContinuation>, Status> {
        let host = self.host_authority(&request)?;
        let delivery = self
            .store
            .get_workspace_continuation(&host, &request.into_inner())
            .await?;
        Ok(Response::new(WorkspaceContinuation { delivery }))
    }

    async fn reserve_delivery(
        &self,
        request: Request<WorkspaceDeliveryRequest>,
    ) -> std::result::Result<Response<WorkspaceDeliveryReference>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .reserve_workspace_delivery(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn commit_delivery(
        &self,
        request: Request<WorkspaceDeliveryRequest>,
    ) -> std::result::Result<Response<WorkspaceDeliveryReference>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .commit_workspace_delivery(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn get_artifact(
        &self,
        request: Request<GetWorkspaceArtifactRequest>,
    ) -> std::result::Result<Response<WorkspaceDeliveryReference>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        self.store
            .ensure_task_access(&principal, &input.task_id)
            .await?;
        Ok(Response::new(
            self.store.get_workspace_artifact(&input).await?,
        ))
    }
}
