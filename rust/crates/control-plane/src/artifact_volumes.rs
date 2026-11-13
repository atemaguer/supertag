//! Registered Volume consent and immutable verified-copy receipts. No bytes or credentials.
use crate::{
    ControlPlane, Store, StoreError,
    policy::{decode, operator},
    store::{Result, invalid, name},
};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{
    artifacts::{MAX_ARTIFACT_FILE_BYTES, validate_artifact_path},
    v2::*,
    valid_sha256,
    volumes::validate_volume_source,
};
use tonic::{Request, Response, Status};
fn hash(kind: &str, input: &impl Message) -> String {
    format!("{kind}:{:x}", Sha256::digest(input.encode_to_vec()))
}
fn conflict() -> StoreError {
    StoreError::Conflict("operation or Volume revision differs".into())
}
fn missing() -> StoreError {
    StoreError::NotFound("Volume or copy was not found".into())
}
fn volume(row: &AnyRow) -> Result<ArtifactVolume> {
    Ok(ArtifactVolume {
        volume_id: row.try_get("volume_id")?,
        source: row.try_get("source")?,
        revision: row.try_get::<i64, _>("revision")? as u64,
    })
}
async fn volume_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<ArtifactVolume> {
    volume(&sqlx::query("SELECT volume_id,source,revision FROM supertag_v2_artifact_volumes WHERE volume_id=$1 AND deleted=0").bind(id).fetch_optional(&mut **tx).await?.ok_or_else(missing)?)
}
async fn prior<M: Message + Default>(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    digest: &str,
) -> Result<Option<M>> {
    let row=sqlx::query("SELECT request_digest,response FROM supertag_v2_artifact_volume_operations WHERE principal=$1 AND operation_id=$2").bind(principal).bind(operation).fetch_optional(&mut **tx).await?;
    match row {
        None => Ok(None),
        Some(row) => {
            if row.try_get::<String, _>("request_digest")? != digest {
                return Err(conflict());
            }
            Ok(Some(decode(&row.try_get::<Vec<u8>, _>("response")?)?))
        }
    }
}
async fn record(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    digest: &str,
    response: &impl Message,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_artifact_volume_operations (principal,operation_id,request_digest,response) VALUES ($1,$2,$3,$4)").bind(principal).bind(operation).bind(digest).bind(response.encode_to_vec()).execute(&mut **tx).await?;
    Ok(())
}
/// Version 48 receipts store the file path inside the immutable protobuf.
pub(crate) async fn backfill_file_paths(tx: &mut Transaction<'_, Any>) -> Result<()> {
    let mut after = 0i64;
    loop {
        let rows = sqlx::query(
            "SELECT copy_id, payload, created_order FROM supertag_v2_artifact_volume_copies
             WHERE created_order>$1 ORDER BY created_order LIMIT 32",
        )
        .bind(after)
        .fetch_all(&mut **tx)
        .await?;
        if rows.is_empty() {
            return Ok(());
        }
        for row in rows {
            let copy: ArtifactVolumeCopy = decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
            let file = copy
                .file
                .ok_or_else(|| invalid("stored Volume copy has no file"))?;
            validate_artifact_path(&file.path).map_err(|error| invalid(error.message()))?;
            sqlx::query(
                "UPDATE supertag_v2_artifact_volume_copies SET file_path=$1 WHERE copy_id=$2",
            )
            .bind(file.path)
            .bind(row.try_get::<String, _>("copy_id")?)
            .execute(&mut **tx)
            .await?;
            after = row.try_get("created_order")?;
        }
    }
}

pub(crate) async fn locations_in(
    tx: &mut Transaction<'_, Any>,
    artifact: &CapturedArtifact,
    file: ArtifactFile,
    ids: &[String],
) -> Result<LocateArtifactVolumeCopiesResponse> {
    if ids.len() > 32 || ids.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(invalid(
            "Volume lookup requires at most 32 ordered unique IDs",
        ));
    }
    let summary = artifact.summary.as_ref().ok_or_else(missing)?;
    let producer = summary.producer.as_ref().ok_or_else(missing)?;
    let blob = file.blob.as_ref().ok_or_else(missing)?;
    let storage_key = format!("attempts/{}/sha256/{}", producer.attempt_id, blob.sha256);
    let mut locations = Vec::with_capacity(ids.len());
    for id in ids {
        name("Volume ID", id)?;
        // The partial index skips reservations and reaches just this file's
        // oldest verified copy for each candidate Volume.
        let row = sqlx::query(
            "SELECT c.payload, v.volume_id, v.source, v.revision
             FROM supertag_v2_artifact_volume_copies c
             JOIN supertag_v2_artifact_volumes v ON v.volume_id=c.volume_id
             WHERE c.artifact_id=$1 AND c.file_path=$2 AND c.volume_id=$3
               AND c.state=2 AND v.deleted=0
             ORDER BY c.created_order LIMIT 1",
        )
        .bind(&summary.artifact_id)
        .bind(&file.path)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some(row) = row else { continue };
        let copy: ArtifactVolumeCopy = decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
        let active = volume(&row)?;
        if copy.artifact_id != summary.artifact_id
            || copy.state() != ArtifactVolumeCopyState::Verified
            || copy.verified_at_ms.is_none()
            || copy.volume.as_ref() != Some(&active)
            || copy.file.as_ref() != Some(&file)
            || copy.storage_key != storage_key
        {
            continue;
        }
        locations.push(ArtifactVolumeLocation {
            volume: Some(active),
            storage_key: storage_key.clone(),
        });
    }
    Ok(LocateArtifactVolumeCopiesResponse { locations })
}

pub(crate) async fn operator_locations(
    store: &Store,
    principal: &str,
    request: &DownloadArtifactFileRequest,
    ids: &[String],
) -> Result<LocateArtifactVolumeCopiesResponse> {
    operator(principal)?;
    name("artifact ID", &request.artifact_id)?;
    validate_artifact_path(&request.path).map_err(|error| invalid(error.message()))?;
    let mut tx = store.pool.begin().await?;
    let capture = access(&mut tx, principal, &request.artifact_id).await?;
    let file = capture
        .files
        .iter()
        .find(|file| file.path == request.path)
        .cloned()
        .ok_or_else(missing)?;
    locations_in(&mut tx, &capture, file, ids).await
}

/// The revision of a live Volume.
pub(crate) async fn revision_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<Option<u64>> {
    let revision: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM supertag_v2_artifact_volumes WHERE volume_id=$1 AND deleted=0",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(revision.map(|value| value as u64))
}

/// Deletes an unused Volume at `expected_revision`.
pub(crate) async fn delete_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
    expected_revision: u64,
) -> Result<()> {
    let volume = volume_in(tx, id).await?;
    if expected_revision != volume.revision {
        return Err(conflict());
    }
    unused(tx, id).await?;
    let revision = i64::try_from(volume.revision)
        .ok()
        .and_then(|v| v.checked_add(1))
        .ok_or_else(|| invalid("Volume revision exhausted"))?;
    sqlx::query("UPDATE supertag_v2_artifact_volumes SET deleted=1,revision=$1 WHERE volume_id=$2")
        .bind(revision)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    crate::apply_sets::forget(tx, "Volume", id).await
}

async fn unused(tx: &mut Transaction<'_, Any>, id: &str) -> Result<()> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_artifact_volume_copies WHERE volume_id=$1",
    )
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    if count != 0 {
        return Err(StoreError::FailedPrecondition(
            "Volume has reserved or verified artifact copies".into(),
        ));
    }
    Ok(())
}
async fn access(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    artifact_id: &str,
) -> Result<CapturedArtifact> {
    let row=sqlx::query("SELECT task_id,payload FROM supertag_v2_artifact_captures WHERE artifact_id=$1 AND committed_order IS NOT NULL").bind(artifact_id).fetch_optional(&mut **tx).await?.ok_or_else(missing)?;
    if !crate::conversations::task_access_in(tx, principal, &row.try_get::<String, _>("task_id")?)
        .await?
    {
        return Err(missing());
    }
    decode(&row.try_get::<Vec<u8>, _>("payload")?)
}
async fn copy_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    id: &str,
) -> Result<ArtifactVolumeCopy> {
    let row=sqlx::query("SELECT artifact_id,payload FROM supertag_v2_artifact_volume_copies WHERE principal=$1 AND copy_id=$2").bind(principal).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(missing)?;
    access(tx, principal, &row.try_get::<String, _>("artifact_id")?).await?;
    decode(&row.try_get::<Vec<u8>, _>("payload")?)
}
fn limit(value: u32, maximum: u32) -> Result<i64> {
    match value {
        0 => Ok(30),
        v if v <= maximum => Ok(v as i64),
        _ => Err(invalid("page limit is too large")),
    }
}
impl Store {
    pub async fn put_artifact_volume(
        &self,
        principal: &str,
        input: &PutArtifactVolumeRequest,
    ) -> Result<ArtifactVolume> {
        operator(principal)?;
        name("Volume ID", &input.volume_id)?;
        name("operation ID", &input.operation_id)?;
        validate_volume_source(&input.source).map_err(|e| invalid(e.message()))?;
        let digest = hash("put", input);
        let (mut tx, _) = self.write().await?;
        if let Some(result) = prior(&mut tx, principal, &input.operation_id, &digest).await? {
            return Ok(result);
        }
        crate::workspace_mounts::allow_artifact_registration(&mut tx, &input.source).await?;
        let row = sqlx::query(
            "SELECT source,revision,deleted FROM supertag_v2_artifact_volumes WHERE volume_id=$1",
        )
        .bind(&input.volume_id)
        .fetch_optional(&mut *tx)
        .await?;
        let revision = if let Some(row) = row {
            let old = row.try_get::<i64, _>("revision")?;
            let deleted = row.try_get::<i64, _>("deleted")? != 0;
            if input.expected_revision != if deleted { 0 } else { old as u64 } {
                return Err(conflict());
            }
            if !deleted && row.try_get::<String, _>("source")? == input.source {
                old
            } else {
                unused(&mut tx, &input.volume_id).await?;
                old.checked_add(1)
                    .ok_or_else(|| invalid("Volume revision exhausted"))?
            }
        } else {
            if input.expected_revision != 0 {
                return Err(conflict());
            }
            1
        };
        let result = ArtifactVolume {
            volume_id: input.volume_id.clone(),
            source: input.source.clone(),
            revision: revision as u64,
        };
        sqlx::query("INSERT INTO supertag_v2_artifact_volumes (volume_id,source,revision,deleted) VALUES ($1,$2,$3,0) ON CONFLICT(volume_id) DO UPDATE SET source=excluded.source,revision=excluded.revision,deleted=0").bind(&input.volume_id).bind(&input.source).bind(revision).execute(&mut *tx).await?;
        record(&mut tx, principal, &input.operation_id, &digest, &result).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn get_artifact_volume(
        &self,
        principal: &str,
        input: &GetArtifactVolumeRequest,
    ) -> Result<ArtifactVolume> {
        operator(principal)?;
        let mut tx = self.pool.begin().await?;
        volume_in(&mut tx, &input.volume_id).await
    }
    pub async fn list_artifact_volumes(
        &self,
        principal: &str,
        input: &ListArtifactVolumesRequest,
    ) -> Result<ListArtifactVolumesResponse> {
        operator(principal)?;
        let cap = limit(input.limit, 100)?;
        let rows=sqlx::query("SELECT volume_id,source,revision FROM supertag_v2_artifact_volumes WHERE deleted=0 AND volume_id>$1 ORDER BY volume_id LIMIT $2").bind(&input.after_id).bind(cap+1).fetch_all(&self.pool).await?;
        let more = rows.len() > cap as usize;
        let volumes = rows
            .iter()
            .take(cap as usize)
            .map(volume)
            .collect::<Result<Vec<_>>>()?;
        let next_after_id = if more {
            volumes.last().unwrap().volume_id.clone()
        } else {
            String::new()
        };
        Ok(ListArtifactVolumesResponse {
            volumes,
            next_after_id,
        })
    }
    pub async fn delete_artifact_volume(
        &self,
        principal: &str,
        input: &DeleteArtifactVolumeRequest,
    ) -> Result<DeleteArtifactVolumeResponse> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let digest = hash("delete", input);
        let (mut tx, _) = self.write().await?;
        if let Some(result) = prior(&mut tx, principal, &input.operation_id, &digest).await? {
            return Ok(result);
        }
        delete_in(&mut tx, &input.volume_id, input.expected_revision).await?;
        let result = DeleteArtifactVolumeResponse { deleted: true };
        record(&mut tx, principal, &input.operation_id, &digest, &result).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn reserve_artifact_volume_copy(
        &self,
        principal: &str,
        input: &CopyArtifactToVolumeRequest,
    ) -> Result<ArtifactVolumeCopy> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        validate_artifact_path(&input.path).map_err(|e| invalid(e.message()))?;
        let blob = input
            .expected_blob
            .as_ref()
            .filter(|b| valid_sha256(&b.sha256) && b.byte_length <= MAX_ARTIFACT_FILE_BYTES)
            .ok_or_else(|| invalid("exact artifact blob consent is required"))?;
        let digest = hash("copy", input);
        let (mut tx, order) = self.write().await?;
        let artifact = access(&mut tx, principal, &input.artifact_id).await?;
        let prior=sqlx::query("SELECT request_digest,payload FROM supertag_v2_artifact_volume_copies WHERE principal=$1 AND operation_id=$2").bind(principal).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(row) = prior {
            if row.try_get::<String, _>("request_digest")? != digest {
                return Err(conflict());
            }
            return decode(&row.try_get::<Vec<u8>, _>("payload")?);
        }
        let volume = volume_in(&mut tx, &input.volume_id).await?;
        if volume.revision != input.expected_revision {
            return Err(conflict());
        }
        let file = artifact
            .files
            .into_iter()
            .find(|f| f.path == input.path)
            .ok_or_else(missing)?;
        if file.blob.as_ref() != Some(blob) {
            return Err(conflict());
        }
        let producer = artifact
            .summary
            .and_then(|v| v.producer)
            .ok_or_else(|| invalid("artifact producer is missing"))?;
        if producer.attempt_id.is_empty()
            || !producer
                .attempt_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(invalid("artifact producer Attempt is invalid"));
        }
        let result = ArtifactVolumeCopy {
            copy_id: uuid::Uuid::new_v4().to_string(),
            operation_id: input.operation_id.clone(),
            volume: Some(volume),
            artifact_id: input.artifact_id.clone(),
            file: Some(file),
            storage_key: format!("attempts/{}/sha256/{}", producer.attempt_id, blob.sha256),
            state: ArtifactVolumeCopyState::Reserved as i32,
            created_at_ms: self.execution_now_ms(),
            verified_at_ms: None,
        };
        if result.encoded_len() > supertag_protocol::MAX_MESSAGE_BYTES - 4096 {
            return Err(invalid(
                "artifact Volume copy receipt exceeds the transport limit",
            ));
        }
        sqlx::query("INSERT INTO supertag_v2_artifact_volume_copies (copy_id,principal,operation_id,volume_id,artifact_id,request_digest,state,payload,created_order,file_path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(&result.copy_id).bind(principal).bind(&input.operation_id).bind(&input.volume_id).bind(&input.artifact_id).bind(digest).bind(result.state as i64).bind(result.encode_to_vec()).bind(order).bind(&input.path).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn commit_artifact_volume_copy(
        &self,
        principal: &str,
        input: &CommitArtifactVolumeCopyRequest,
    ) -> Result<ArtifactVolumeCopy> {
        operator(principal)?;
        let (mut tx, _) = self.write().await?;
        let mut copy = copy_in(&mut tx, principal, &input.copy_id).await?;
        if input.verified_blob.is_none()
            || input.verified_blob.as_ref() != copy.file.as_ref().and_then(|f| f.blob.as_ref())
        {
            return Err(conflict());
        }
        let expected = copy
            .volume
            .as_ref()
            .ok_or_else(|| invalid("copy Volume is missing"))?;
        if &volume_in(&mut tx, &expected.volume_id).await? != expected {
            return Err(conflict());
        }
        if copy.state() == ArtifactVolumeCopyState::Verified {
            return Ok(copy);
        }
        copy.state = ArtifactVolumeCopyState::Verified as i32;
        copy.verified_at_ms = Some(self.execution_now_ms());
        sqlx::query(
            "UPDATE supertag_v2_artifact_volume_copies SET state=$1,payload=$2 WHERE copy_id=$3",
        )
        .bind(copy.state as i64)
        .bind(copy.encode_to_vec())
        .bind(&copy.copy_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(copy)
    }
    pub async fn get_artifact_volume_copy(
        &self,
        principal: &str,
        input: &GetArtifactVolumeCopyRequest,
    ) -> Result<ArtifactVolumeCopy> {
        operator(principal)?;
        let mut tx = self.pool.begin().await?;
        copy_in(&mut tx, principal, &input.copy_id).await
    }
    pub async fn list_artifact_volume_copies(
        &self,
        principal: &str,
        input: &ListArtifactVolumeCopiesRequest,
    ) -> Result<ListArtifactVolumeCopiesResponse> {
        operator(principal)?;
        let cap = limit(input.limit, 50)?;
        let before =
            i64::try_from(input.before_order).map_err(|_| invalid("invalid copy cursor"))?;
        let mut tx = self.pool.begin().await?;
        let rows=sqlx::query("SELECT c.payload,c.created_order FROM supertag_v2_artifact_volume_copies c JOIN supertag_v2_artifact_captures a ON a.artifact_id=c.artifact_id JOIN supertag_v2_task_audience audience ON audience.task_id=a.task_id WHERE c.principal=$1 AND (audience.owner='' OR audience.owner=$1) AND ($2='' OR c.volume_id=$2) AND ($3=0 OR c.created_order<$3) ORDER BY c.created_order DESC LIMIT $4").bind(principal).bind(&input.volume_id).bind(before).bind(cap+1).fetch_all(&mut *tx).await?;
        let mut copies = Vec::new();
        let mut bytes = 0usize;
        let mut last = 0u64;
        let mut more = false;
        for row in rows {
            let copy: ArtifactVolumeCopy = decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
            if copies.len() == cap as usize
                || bytes + copy.encoded_len() + 16 > supertag_protocol::MAX_MESSAGE_BYTES - 4096
            {
                more = true;
                break;
            }
            bytes += copy.encoded_len() + 16;
            last = row.try_get::<i64, _>("created_order")? as u64;
            copies.push(copy);
        }
        let next_before_order = if more { last } else { 0 };
        Ok(ListArtifactVolumeCopiesResponse {
            copies,
            next_before_order,
        })
    }
}

#[tonic::async_trait]
impl artifact_volume_directory_server::ArtifactVolumeDirectory for ControlPlane {
    async fn put(
        &self,
        request: Request<PutArtifactVolumeRequest>,
    ) -> std::result::Result<Response<ArtifactVolume>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_artifact_volume(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get(
        &self,
        request: Request<GetArtifactVolumeRequest>,
    ) -> std::result::Result<Response<ArtifactVolume>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_artifact_volume(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list(
        &self,
        request: Request<ListArtifactVolumesRequest>,
    ) -> std::result::Result<Response<ListArtifactVolumesResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_artifact_volumes(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn delete(
        &self,
        request: Request<DeleteArtifactVolumeRequest>,
    ) -> std::result::Result<Response<DeleteArtifactVolumeResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .delete_artifact_volume(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn reserve_copy(
        &self,
        request: Request<CopyArtifactToVolumeRequest>,
    ) -> std::result::Result<Response<ArtifactVolumeCopy>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .reserve_artifact_volume_copy(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn commit_copy(
        &self,
        request: Request<CommitArtifactVolumeCopyRequest>,
    ) -> std::result::Result<Response<ArtifactVolumeCopy>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .commit_artifact_volume_copy(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get_copy(
        &self,
        request: Request<GetArtifactVolumeCopyRequest>,
    ) -> std::result::Result<Response<ArtifactVolumeCopy>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_artifact_volume_copy(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list_copies(
        &self,
        request: Request<ListArtifactVolumeCopiesRequest>,
    ) -> std::result::Result<Response<ListArtifactVolumeCopiesResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_artifact_volume_copies(&principal, request.get_ref())
                .await?,
        ))
    }
}
