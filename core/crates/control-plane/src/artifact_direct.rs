//! Authority for exact, short-lived reads from a producing Worker Host.
use crate::{
    ControlPlane, HostAuthority, Store, StoreError,
    store::{Result, invalid, owned},
};
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{
    artifacts::{MAX_ARTIFACT_FILE_BYTES, validate_artifact_path},
    v2::*,
    valid_sha256,
};
use tonic::{Request, Response, Status};
use uuid::Uuid;

const GRANT_MS: i64 = 10_000;
const MAX_ACTIVE_GRANTS: i64 = 128;

fn denied() -> StoreError {
    StoreError::PermissionDenied
}

pub(crate) fn validate_storage_id(id: &str) -> Result<()> {
    if Uuid::parse_str(id).is_ok_and(|uuid| uuid.get_version_num() == 4 && uuid.to_string() == id) {
        Ok(())
    } else {
        Err(invalid("invalid artifact source storage ID"))
    }
}

pub(crate) async fn check_source_in(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    storage: &str,
) -> Result<()> {
    validate_storage_id(storage)?;
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT s.host_generation FROM supertag_v2_artifact_sources s
         JOIN supertag_v2_hosts h ON h.host_id=s.host_id
         WHERE s.host_id=$1 AND s.storage_id=$2 AND s.host_generation=$3
           AND h.generation=$3 AND h.revoked_at_ms IS NULL",
    )
    .bind(host.id())
    .bind(storage)
    .bind(host.generation)
    .fetch_optional(&mut **tx)
    .await?;
    current.ok_or_else(denied)?;
    Ok(())
}

pub(crate) async fn commit_copy_in(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    artifact: &CapturedArtifact,
    storage: &str,
) -> Result<()> {
    check_source_in(tx, host, storage).await?;
    let id = &artifact.summary.as_ref().ok_or_else(denied)?.artifact_id;
    sqlx::query(
        "INSERT INTO supertag_v2_artifact_host_copies (artifact_id,host_id,storage_id)
         VALUES ($1,$2,$3)",
    )
    .bind(id)
    .bind(host.id())
    .bind(storage)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn source_in(tx: &mut Transaction<'_, Any>, artifact_id: &str) -> Result<AnyRow> {
    sqlx::query(
        "SELECT c.host_id,c.storage_id,s.host_generation
         FROM supertag_v2_artifact_host_copies c
         JOIN supertag_v2_artifact_sources s ON s.host_id=c.host_id AND s.storage_id=c.storage_id
         JOIN supertag_v2_hosts h ON h.host_id=s.host_id AND h.generation=s.host_generation
         WHERE c.artifact_id=$1 AND h.revoked_at_ms IS NULL",
    )
    .bind(artifact_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| StoreError::NotFound("artifact has no current direct source Worker Host".into()))
}

fn remaining(deadline: i64, now: i64) -> Result<u64> {
    u64::try_from(deadline.saturating_sub(now))
        .ok()
        .filter(|left| *left > 0 && *left <= GRANT_MS as u64)
        .ok_or_else(denied)
}

impl Store {
    pub async fn register_artifact_source(
        &self,
        host: &HostAuthority,
        input: &RegisterArtifactSourceRequest,
    ) -> Result<RegisterArtifactSourceResponse> {
        validate_storage_id(&input.storage_id)?;
        let (mut tx, _) = self.write().await?;
        let generation: Option<i64> = sqlx::query_scalar(
            "SELECT generation FROM supertag_v2_hosts WHERE host_id=$1 AND revoked_at_ms IS NULL",
        )
        .bind(host.id())
        .fetch_optional(&mut *tx)
        .await?;
        if generation != Some(host.generation) {
            return Err(denied());
        }
        let previous = sqlx::query(
            "SELECT host_generation,storage_id FROM supertag_v2_artifact_sources WHERE host_id=$1",
        )
        .bind(host.id())
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(previous) = previous
            && previous.try_get::<i64, _>("host_generation")? == host.generation
            && previous.try_get::<String, _>("storage_id")? != input.storage_id
        {
            return Err(StoreError::Conflict(
                "Worker Host generation already registered another artifact storage".into(),
            ));
        }
        sqlx::query(
            "INSERT INTO supertag_v2_artifact_sources (host_id,host_generation,storage_id)
             VALUES ($1,$2,$3) ON CONFLICT(host_id) DO UPDATE
             SET host_generation=excluded.host_generation,storage_id=excluded.storage_id",
        )
        .bind(host.id())
        .bind(host.generation)
        .bind(&input.storage_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(RegisterArtifactSourceResponse {
            storage_id: input.storage_id.clone(),
        })
    }

    pub async fn issue_artifact_transfer(
        &self,
        host: &HostAuthority,
        input: &GetAcquiredArtifactFileRequest,
    ) -> Result<ArtifactTransferGrant> {
        validate_artifact_path(&input.path).map_err(|error| invalid(error.message()))?;
        let attempt = input.attempt.as_ref().ok_or_else(denied)?;
        let (mut tx, _) = self.write().await?;
        let (capture, file) = self.acquired_source_in(&mut tx, host, input).await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let now = self.execution_now_ms();
        let lease = row
            .try_get::<Option<i64>, _>("lease_expires_at_ms")?
            .ok_or_else(denied)?;
        let expires = now.saturating_add(GRANT_MS).min(lease);
        let valid_for_ms = remaining(expires, now)?;
        let artifact_id = &capture.summary.as_ref().ok_or_else(denied)?.artifact_id;
        let source = source_in(&mut tx, artifact_id).await?;
        let source_host_id: String = source.try_get("host_id")?;
        let source_generation: i64 = source.try_get("host_generation")?;
        let storage: String = source.try_get("storage_id")?;
        let active: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM supertag_v2_artifact_transfer_grants
             WHERE consumer_host_id=$1 AND consumer_generation=$2 AND expires_at_ms>$3",
        )
        .bind(host.id())
        .bind(host.generation)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
        if active >= MAX_ACTIVE_GRANTS {
            return Err(StoreError::FailedPrecondition(
                "too many active artifact transfer grants".into(),
            ));
        }
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        sqlx::query(
            "INSERT INTO supertag_v2_artifact_transfer_grants
             (token_digest,acquisition_id,consumer_host_id,consumer_generation,
              source_host_id,source_generation,source_storage_id,path,expires_at_ms)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        )
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .bind(&input.acquisition_id)
        .bind(host.id())
        .bind(host.generation)
        .bind(&source_host_id)
        .bind(source_generation)
        .bind(storage)
        .bind(&input.path)
        .bind(expires)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(ArtifactTransferGrant {
            token,
            source_host_id,
            valid_for_ms,
            file: Some(file),
        })
    }

    pub async fn authorize_artifact_transfer(
        &self,
        source_host: &HostAuthority,
        input: &AuthorizeArtifactTransferRequest,
    ) -> Result<AuthorizedArtifactTransfer> {
        let request = input.file.as_ref().ok_or_else(denied)?;
        if !valid_sha256(&input.token)
            || request.blob.as_ref().is_none_or(|blob| {
                !valid_sha256(&blob.sha256) || blob.byte_length > MAX_ARTIFACT_FILE_BYTES
            })
        {
            return Err(denied());
        }
        validate_artifact_path(&request.path).map_err(|_| denied())?;
        let mut tx = self.pool.begin().await?;
        let now = self.execution_now_ms();
        let row = sqlx::query(
            "SELECT g.consumer_host_id,g.consumer_generation,g.source_storage_id,g.expires_at_ms,
                    a.acquisition_id,a.task_id,a.attempt_id,t.lease_token
             FROM supertag_v2_artifact_transfer_grants g
             JOIN supertag_v2_artifact_acquisitions a ON a.acquisition_id=g.acquisition_id
             JOIN supertag_v2_tasks t ON t.task_id=a.task_id AND t.attempt_id=a.attempt_id
             WHERE g.token_digest=$1 AND g.source_host_id=$2 AND g.source_generation=$3
               AND g.path=$4 AND a.artifact_id=$5 AND g.expires_at_ms>$6",
        )
        .bind(Sha256::digest(input.token.as_bytes()).to_vec())
        .bind(source_host.id())
        .bind(source_host.generation)
        .bind(&request.path)
        .bind(&request.artifact_id)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(denied)?;
        let storage: String = row.try_get("source_storage_id")?;
        check_source_in(&mut tx, source_host, &storage).await?;
        let consumer = HostAuthority::new(
            format!("host:{}", row.try_get::<String, _>("consumer_host_id")?),
            row.try_get::<i64, _>("consumer_generation")? as u64,
        )?;
        let attempt = InspectAttemptRequest {
            task_id: row.try_get("task_id")?,
            attempt_id: row.try_get("attempt_id")?,
            lease_token: row
                .try_get::<Option<String>, _>("lease_token")?
                .ok_or_else(denied)?,
        };
        let (capture, file) = self
            .acquired_source_in(
                &mut tx,
                &consumer,
                &GetAcquiredArtifactFileRequest {
                    attempt: Some(attempt),
                    acquisition_id: row.try_get("acquisition_id")?,
                    path: request.path.clone(),
                },
            )
            .await?;
        if file.blob != request.blob {
            return Err(denied());
        }
        let producer = capture
            .summary
            .and_then(|summary| summary.producer)
            .ok_or_else(denied)?;
        let valid_for_ms = remaining(row.try_get("expires_at_ms")?, self.execution_now_ms())?;
        Ok(AuthorizedArtifactTransfer {
            producer_attempt_id: producer.attempt_id,
            file: Some(file),
            valid_for_ms,
        })
    }

    pub(crate) async fn sweep_artifact_transfer_grants(&self) -> Result<()> {
        sqlx::query("DELETE FROM supertag_v2_artifact_transfer_grants WHERE expires_at_ms<=$1")
            .bind(self.execution_now_ms())
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

impl ControlPlane {
    pub(crate) async fn register_artifact_source(
        &self,
        request: Request<RegisterArtifactSourceRequest>,
    ) -> std::result::Result<Response<RegisterArtifactSourceResponse>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .register_artifact_source(&host, request.get_ref())
                .await?,
        ))
    }

    pub(crate) async fn issue_artifact_transfer(
        &self,
        request: Request<GetAcquiredArtifactFileRequest>,
    ) -> std::result::Result<Response<ArtifactTransferGrant>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .issue_artifact_transfer(&host, request.get_ref())
                .await?,
        ))
    }

    pub(crate) async fn authorize_artifact_transfer(
        &self,
        request: Request<AuthorizeArtifactTransferRequest>,
    ) -> std::result::Result<Response<AuthorizedArtifactTransfer>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .authorize_artifact_transfer(&host, request.get_ref())
                .await?,
        ))
    }
}
