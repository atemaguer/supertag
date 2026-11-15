use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{v2::*, valid_sha256, validate_checkpoint_reference};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store, StoreError,
    store::{HostAuthority, Result, invalid, lease_is_live, owned},
};

impl Store {
    pub async fn get_checkpoint(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
    ) -> Result<Option<CheckpointReference>> {
        let mut tx = self.pool.begin().await?;
        let task = require_running(&mut tx, host, attempt, self.execution_now_ms()).await?;
        let row = sqlx::query("SELECT c.* FROM supertag_v2_session_checkpoints s JOIN supertag_v2_checkpoints c ON s.attempt_id=c.attempt_id WHERE s.tag_id=$1 AND s.session_id=$2 AND c.committed=1")
            .bind(task.try_get::<String, _>("tag_id")?)
            .bind(task.try_get::<String, _>("session_id")?)
            .fetch_optional(&mut *tx).await?;
        let reference = row.as_ref().map(reference_row).transpose()?;
        tx.commit().await?;
        Ok(reference)
    }

    pub async fn reserve_checkpoint(
        &self,
        host: &HostAuthority,
        input: &CommitCheckpointRequest,
    ) -> Result<CheckpointReference> {
        let (attempt, reference) = checkpoint_input(input)?;
        let (mut tx, _) = self.write().await?;
        require_running(&mut tx, host, attempt, self.execution_now_ms()).await?;
        if let Some(prior) = reservation_in(&mut tx, attempt).await? {
            check_reference(&prior, reference)?;
        } else {
            sqlx::query("INSERT INTO supertag_v2_checkpoints (attempt_id,task_id,harness,format,byte_length,sha256) VALUES ($1,$2,$3,$4,$5,$6)")
                .bind(&attempt.attempt_id)
                .bind(&attempt.task_id)
                .bind(&reference.harness)
                .bind(&reference.format)
                .bind(reference.byte_length as i64)
                .bind(&reference.sha256)
                .execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(reference.clone())
    }

    pub async fn commit_checkpoint(
        &self,
        host: &HostAuthority,
        input: &CommitCheckpointRequest,
    ) -> Result<CheckpointReference> {
        let (attempt, reference) = checkpoint_input(input)?;
        let (mut tx, _) = self.write().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let reservation = reservation_in(&mut tx, attempt).await?.ok_or_else(|| {
            StoreError::FailedPrecondition("checkpoint reservation is missing".into())
        })?;
        check_reference(&reservation, reference)?;
        if reservation.try_get::<i64, _>("committed")? == 0 {
            require_running_row(&task, self.execution_now_ms())?;
            sqlx::query(
                "UPDATE supertag_v2_checkpoints SET committed=1 WHERE attempt_id=$1 AND task_id=$2",
            )
            .bind(&attempt.attempt_id)
            .bind(&attempt.task_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(reference.clone())
    }
}

pub(crate) async fn finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: &FinishTaskRequest,
) -> Result<()> {
    if let Some(digest) = &input.checkpoint_sha256 {
        if !valid_sha256(digest) {
            return Err(invalid("invalid checkpoint digest"));
        }
        let committed: Option<String> = sqlx::query_scalar(
            "SELECT sha256 FROM supertag_v2_checkpoints WHERE attempt_id=$1 AND task_id=$2 AND committed=1",
        )
        .bind(&input.attempt_id)
        .bind(&input.task_id)
        .fetch_optional(&mut **tx)
        .await?;
        if committed.as_ref() != Some(digest) {
            return Err(StoreError::FailedPrecondition(
                "checkpoint commit is missing or mismatched".into(),
            ));
        }
        sqlx::query("INSERT INTO supertag_v2_session_checkpoints (tag_id,session_id,attempt_id) VALUES ($1,$2,$3) ON CONFLICT(tag_id,session_id) DO UPDATE SET attempt_id=excluded.attempt_id")
            .bind(&task.tag_id)
            .bind(&task.session_id)
            .bind(&input.attempt_id)
            .execute(&mut **tx).await?;
    } else {
        sqlx::query(
            "DELETE FROM supertag_v2_session_checkpoints WHERE tag_id=$1 AND session_id=$2",
        )
        .bind(&task.tag_id)
        .bind(&task.session_id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

fn checkpoint_input(
    input: &CommitCheckpointRequest,
) -> Result<(&InspectAttemptRequest, &CheckpointReference)> {
    let attempt = input
        .attempt
        .as_ref()
        .ok_or_else(|| invalid("Attempt identity required"))?;
    let reference = input
        .reference
        .as_ref()
        .ok_or_else(|| invalid("checkpoint reference required"))?;
    validate_checkpoint_reference(reference).map_err(|status| invalid(status.message()))?;
    Ok((attempt, reference))
}

async fn reservation_in(
    tx: &mut Transaction<'_, Any>,
    attempt: &InspectAttemptRequest,
) -> Result<Option<AnyRow>> {
    Ok(
        sqlx::query("SELECT * FROM supertag_v2_checkpoints WHERE attempt_id=$1 AND task_id=$2")
            .bind(&attempt.attempt_id)
            .bind(&attempt.task_id)
            .fetch_optional(&mut **tx)
            .await?,
    )
}

fn check_reference(row: &AnyRow, reference: &CheckpointReference) -> Result<()> {
    if &reference_row(row)? != reference {
        return Err(StoreError::Conflict(
            "Attempt already reserved a different checkpoint".into(),
        ));
    }
    Ok(())
}

async fn require_running(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    now: i64,
) -> Result<AnyRow> {
    let row = owned(
        tx,
        host,
        &attempt.task_id,
        &attempt.attempt_id,
        &attempt.lease_token,
    )
    .await?;
    require_running_row(&row, now)?;
    Ok(row)
}

fn require_running_row(row: &AnyRow, now: i64) -> Result<()> {
    if row.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(row, now)? {
        return Err(StoreError::FailedPrecondition(
            "Attempt is not running with current authority".into(),
        ));
    }
    Ok(())
}

fn reference_row(row: &AnyRow) -> Result<CheckpointReference> {
    Ok(CheckpointReference {
        harness: row.try_get("harness")?,
        format: row.try_get("format")?,
        byte_length: row.try_get::<i64, _>("byte_length")? as u64,
        sha256: row.try_get("sha256")?,
    })
}

#[tonic::async_trait]
impl checkpoint_directory_server::CheckpointDirectory for ControlPlane {
    async fn get_checkpoint(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> std::result::Result<Response<GetCheckpointResponse>, Status> {
        let host = self.host_authority(&request)?;
        let reference = self
            .store
            .get_checkpoint(&host, &request.into_inner())
            .await?;
        Ok(Response::new(GetCheckpointResponse { reference }))
    }

    async fn commit_checkpoint(
        &self,
        request: Request<CommitCheckpointRequest>,
    ) -> std::result::Result<Response<CheckpointReference>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .commit_checkpoint(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn reserve_checkpoint(
        &self,
        request: Request<CommitCheckpointRequest>,
    ) -> std::result::Result<Response<CheckpointReference>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .reserve_checkpoint(&host, &request.into_inner())
                .await?,
        ))
    }
}
