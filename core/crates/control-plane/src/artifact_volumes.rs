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
    artifacts::validate_artifact_path, v2::*, volumes::validate_volume_source,
};
use tonic::{Request, Response, Status};
/// The root of everything a Tag keeps on its Volume. Hashing keeps Tag IDs out of object keys.
pub(crate) fn tag_root(tag_id: &str) -> String {
    format!("tags/{:x}", Sha256::digest(tag_id.as_bytes()))
}

/// Where a capture's file lives on its Tag's Volume.
pub(crate) fn capture_key(tag_id: &str, attempt_id: &str, sha256: &str) -> String {
    format!("{}/attempts/{attempt_id}/sha256/{sha256}", tag_root(tag_id))
}

/// Where a Session's checkpoint with these bytes lives on its Tag's Volume: the same layout as a
/// Worker Host's own artifact storage.
pub(crate) fn checkpoint_key(tag_id: &str, session_id: &str, sha256: &str) -> String {
    format!(
        "{}/sessions/{:x}/checkpoint/{sha256}.bin",
        tag_root(tag_id),
        Sha256::digest(session_id.as_bytes())
    )
}

/// Where one object of a Tag's native memory store lives on its Volume: content-addressed under
/// the store's `objects/`, so it is never overwritten.
pub(crate) fn native_memory_key(tag_id: &str, harness: &str, scope: &str, sha256: &str) -> String {
    format!(
        "{}/native-memory/{harness}/{scope}/objects/{sha256}",
        tag_root(tag_id)
    )
}

/// The key and bytes of one object of the native memory store this turn was granted: its harness
/// and audience scope come from the Attempt, never the request.
async fn native_memory_object_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: &VolumeObjectGrantRequest,
) -> Result<(String, BlobReference)> {
    let blob = input
        .native_memory_blob
        .clone()
        .filter(|blob| {
            supertag_protocol::valid_sha256(&blob.sha256)
                && blob.byte_length <= supertag_protocol::MAX_CHECKPOINT_BYTES as u64
        })
        .ok_or_else(|| invalid("a native memory grant needs a valid blob"))?;
    let grant = crate::native_memory::grant_in(tx, task)
        .await?
        .ok_or_else(|| StoreError::FailedPrecondition("this turn keeps no native memory".into()))?;
    let harness = task
        .attempt_execution
        .as_ref()
        .and_then(|execution| supertag_protocol::checkpoint_harness(execution.harness_kind()))
        .ok_or_else(|| {
            StoreError::FailedPrecondition("this turn's harness keeps no native memory".into())
        })?;
    Ok((
        native_memory_key(&task.tag_id, harness, &grant.scope, &blob.sha256),
        blob,
    ))
}

/// Two records of one Volume name the same storage: a new revision that only changed nothing
/// about where it lives still holds the same objects.
fn same_storage(left: &ArtifactVolume, right: &ArtifactVolume) -> bool {
    left.volume_id == right.volume_id && left.source == right.source
}

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

/// The oldest verified copy of a capture's file on a registered Volume that still names the same
/// storage.
async fn verified_location_in(
    tx: &mut Transaction<'_, Any>,
    artifact: &CapturedArtifact,
    file: &ArtifactFile,
) -> Result<Option<ArtifactVolumeLocation>> {
    let summary = artifact.summary.as_ref().ok_or_else(missing)?;
    let rows = sqlx::query(
        "SELECT c.payload, v.volume_id, v.source, v.revision
         FROM supertag_v2_artifact_volume_copies c
         JOIN supertag_v2_artifact_volumes v ON v.volume_id=c.volume_id
         WHERE c.artifact_id=$1 AND c.file_path=$2 AND c.state=2 AND v.deleted=0
         ORDER BY c.created_order LIMIT 8",
    )
    .bind(&summary.artifact_id)
    .bind(&file.path)
    .fetch_all(&mut **tx)
    .await?;
    for row in rows {
        let copy: ArtifactVolumeCopy = decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
        let active = volume(&row)?;
        if copy.artifact_id == summary.artifact_id
            && copy.state() == ArtifactVolumeCopyState::Verified
            && copy
                .volume
                .as_ref()
                .is_some_and(|volume| same_storage(volume, &active))
            && copy.file.as_ref() == Some(file)
        {
            return Ok(Some(ArtifactVolumeLocation {
                volume: Some(active),
                storage_key: copy.storage_key,
            }));
        }
    }
    Ok(None)
}

pub(crate) async fn locations_in(
    tx: &mut Transaction<'_, Any>,
    artifact: &CapturedArtifact,
    file: ArtifactFile,
    ids: &[String],
) -> Result<LocateArtifactCopiesResponse> {
    if ids.len() > 32 || ids.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(invalid(
            "Volume lookup requires at most 32 ordered unique IDs",
        ));
    }
    let summary = artifact.summary.as_ref().ok_or_else(missing)?;
    let producer = summary.producer.as_ref().ok_or_else(missing)?;
    let blob = file.blob.as_ref().ok_or_else(missing)?;
    let storage_key = capture_key(&producer.tag_id, &producer.attempt_id, &blob.sha256);
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
            || copy
                .volume
                .as_ref()
                .is_none_or(|volume| !same_storage(volume, &active))
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
    let holder: Option<String> = sqlx::query_scalar(
        "SELECT host_id FROM supertag_v2_artifact_host_copies WHERE artifact_id=$1",
    )
    .bind(&summary.artifact_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(LocateArtifactCopiesResponse {
        locations,
        holder: holder.map(|host_id| BlobHolder {
            host_id,
            attempt_id: producer.attempt_id.clone(),
        }),
    })
}

pub(crate) async fn operator_locations(
    store: &Store,
    principal: &str,
    request: &DownloadArtifactFileRequest,
    ids: &[String],
) -> Result<LocateArtifactCopiesResponse> {
    crate::store::actor(principal)?;
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

/// The principal of the copies a capture makes because its Tag names a Volume. Readers see them
/// as they see the capture.
pub(crate) const CAPTURE_PRINCIPAL: &str = "capture";

/// A Tag's `volume` being written: as requested (empty removes it), else as it was. A
/// named Volume must exist.
pub(crate) async fn tag_volume_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    requested: Option<String>,
) -> Result<Option<String>> {
    match requested {
        Some(id) if id.is_empty() => Ok(None),
        Some(id) => {
            crate::store::resource_id("Volume ID", &id)?;
            if revision_in(tx, &id).await?.is_none() {
                return Err(StoreError::FailedPrecondition(format!(
                    "artifact Volume {id} does not exist"
                )));
            }
            Ok(Some(id))
        }
        None => Ok(sqlx::query_scalar::<_, Option<String>>(
            "SELECT volume FROM supertag_v2_tags WHERE tag_id=$1",
        )
        .bind(tag_id)
        .fetch_optional(&mut **tx)
        .await?
        .flatten()),
    }
}

/// The Tag's Volume as an Attempt's assignment carries it.
pub(crate) async fn assigned_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
) -> Result<Option<AssignedVolume>> {
    let Some(id) = tag_volume_in(tx, tag_id, None).await? else {
        return Ok(None);
    };
    Ok(volume_in(tx, &id).await.ok().map(|volume| AssignedVolume {
        volume_id: volume.volume_id,
        source: volume.source,
        revision: volume.revision,
    }))
}

/// Reserves a copy of each file of a new capture on the artifact Volume its Tag names. None when
/// the Tag names no Volume.
pub(crate) async fn reserve_capture_copies_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    artifact: &CapturedArtifact,
    now: i64,
) -> Result<Vec<ArtifactVolumeCopy>> {
    let Some(id) = tag_volume_in(tx, tag_id, None).await? else {
        return Ok(vec![]);
    };
    let volume = volume_in(tx, &id).await.map_err(|_| {
        StoreError::FailedPrecondition(format!("the Tag's Volume {id} no longer exists"))
    })?;
    let summary = artifact.summary.as_ref().ok_or_else(missing)?;
    let attempt = summary
        .producer
        .as_ref()
        .map(|producer| producer.attempt_id.as_str())
        .filter(|attempt| {
            !attempt.is_empty()
                && attempt
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        })
        .ok_or_else(|| invalid("artifact producer Attempt is invalid"))?;
    let mut copies = Vec::with_capacity(artifact.files.len());
    for (index, file) in artifact.files.iter().enumerate() {
        let blob = file.blob.as_ref().ok_or_else(missing)?;
        let copy = ArtifactVolumeCopy {
            copy_id: uuid::Uuid::new_v4().to_string(),
            operation_id: format!("{}/{index}", summary.artifact_id),
            volume: Some(volume.clone()),
            artifact_id: summary.artifact_id.clone(),
            file: Some(file.clone()),
            storage_key: capture_key(tag_id, attempt, &blob.sha256),
            state: ArtifactVolumeCopyState::Reserved as i32,
            created_at_ms: now,
            verified_at_ms: None,
            upload: None,
            host_attested: false,
        };
        let order = crate::store::next_order(tx).await?;
        sqlx::query("INSERT INTO supertag_v2_artifact_volume_copies (copy_id,principal,operation_id,volume_id,artifact_id,request_digest,state,payload,created_order,file_path) VALUES ($1,$2,$3,$4,$5,'',$6,$7,$8,$9)")
            .bind(&copy.copy_id).bind(CAPTURE_PRINCIPAL).bind(&copy.operation_id).bind(&id)
            .bind(&copy.artifact_id).bind(copy.state as i64).bind(copy.encode_to_vec()).bind(order)
            .bind(&file.path)
            .execute(&mut **tx).await?;
        copies.push(copy);
    }
    Ok(copies)
}

/// The copies a capture reserved on its Tag's artifact Volume, in file order.
pub(crate) async fn capture_copies_in(
    tx: &mut Transaction<'_, Any>,
    artifact_id: &str,
) -> Result<Vec<ArtifactVolumeCopy>> {
    let rows = sqlx::query(
        "SELECT payload FROM supertag_v2_artifact_volume_copies
         WHERE artifact_id=$1 AND principal=$2 ORDER BY created_order",
    )
    .bind(artifact_id)
    .bind(CAPTURE_PRINCIPAL)
    .fetch_all(&mut **tx)
    .await?;
    rows.iter()
        .map(|row| decode(&row.try_get::<Vec<u8>, _>("payload")?))
        .collect()
}

/// Records a capture's copies as Verified when it commits. The API tier checked each S3 copy with
/// a HEAD before it asked to commit; a file copy is the capturing host's own attestation, as the
/// Control Plane maps no Volume. The Volume must still be the one each copy names.
pub(crate) async fn verify_capture_copies_in(
    tx: &mut Transaction<'_, Any>,
    artifact_id: &str,
    now: i64,
) -> Result<Vec<ArtifactVolumeCopy>> {
    let mut copies = capture_copies_in(tx, artifact_id).await?;
    for copy in &mut copies {
        if copy.state() == ArtifactVolumeCopyState::Verified {
            continue;
        }
        let expected = copy.volume.as_ref().ok_or_else(missing)?;
        if !volume_in(tx, &expected.volume_id)
            .await
            .is_ok_and(|current| same_storage(&current, expected))
        {
            return Err(StoreError::Conflict(
                "the Tag's Volume changed during the capture".into(),
            ));
        }
        copy.host_attested = expected.source.starts_with("file:");
        copy.state = ArtifactVolumeCopyState::Verified as i32;
        copy.verified_at_ms = Some(now);
        sqlx::query(
            "UPDATE supertag_v2_artifact_volume_copies SET state=$1,payload=$2 WHERE copy_id=$3",
        )
        .bind(copy.state as i64)
        .bind(copy.encode_to_vec())
        .bind(&copy.copy_id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(copies)
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
    abandon_in(tx, id).await?;
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

/// Sends everything still stored on a Volume that is being deleted to Volume garbage, under its
/// current source, and drops the rows that named it: Sessions whose checkpoint was there start
/// fresh with a recap, and native memory stores there start empty. The garbage rows keep the
/// source, so the S3 sweep (signing with the Volume's credential, which stays in the vault) or a
/// Worker Host that still maps the file Volume deletes the objects after the Volume is gone.
async fn abandon_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<()> {
    let attempts: Vec<String> =
        sqlx::query_scalar("SELECT attempt_id FROM supertag_v2_checkpoints WHERE volume_id=$1")
            .bind(id)
            .fetch_all(&mut **tx)
            .await?;
    for attempt in attempts {
        crate::volume_garbage::queue_checkpoint_in(tx, &attempt).await?;
        sqlx::query("DELETE FROM supertag_v2_session_checkpoints WHERE attempt_id=$1")
            .bind(&attempt)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM supertag_v2_checkpoints WHERE attempt_id=$1")
            .bind(&attempt)
            .execute(&mut **tx)
            .await?;
    }
    let objects = sqlx::query(
        "SELECT tag_id,storage_key,sha256,byte_length FROM supertag_v2_native_memory_volume_objects
         WHERE volume_id=$1
         UNION ALL
         SELECT tag_id,storage_key,sha256,byte_length FROM supertag_v2_native_memory_pending_objects
         WHERE volume_id=$1",
    )
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    for object in &objects {
        crate::volume_garbage::queue_native_object_in(
            tx,
            &object.try_get::<String, _>("tag_id")?,
            id,
            &object.try_get::<String, _>("storage_key")?,
            &BlobReference {
                sha256: object.try_get("sha256")?,
                byte_length: object.try_get::<i64, _>("byte_length")?.max(0) as u64,
            },
        )
        .await?;
    }
    for table in [
        "supertag_v2_native_memory_volume_objects",
        "supertag_v2_native_memory_pending_objects",
        "supertag_v2_native_memory_volume_heads",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE volume_id=$1"))
            .bind(id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// A Volume's storage can change only once nothing is left at the old one: neither rows that name
/// objects there, nor garbage the sweep has yet to delete. The sweep signs with the Volume's one
/// credential, which then belongs to the new storage, so it could not be trusted to reach the old.
async fn storage_movable(
    tx: &mut Transaction<'_, Any>,
    id: &str,
    source: &str,
    live: bool,
) -> Result<()> {
    if live {
        let held: i64 = sqlx::query_scalar(
            "SELECT (SELECT COUNT(*) FROM supertag_v2_checkpoints WHERE volume_id=$1)
                  + (SELECT COUNT(*) FROM supertag_v2_native_memory_volume_objects WHERE volume_id=$1)
                  + (SELECT COUNT(*) FROM supertag_v2_native_memory_pending_objects WHERE volume_id=$1)
                  + (SELECT COUNT(*) FROM supertag_v2_native_memory_volume_heads WHERE volume_id=$1)",
        )
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
        if held != 0 {
            return Err(StoreError::FailedPrecondition(format!(
                "Volume {id} still holds Session checkpoints or native memory: delete the Volume, which sends them for deletion (those Sessions and memories start fresh), then register it with the new source once they are gone"
            )));
        }
    }
    let waiting: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_volume_garbage WHERE volume_id=$1 AND source<>$2",
    )
    .bind(id)
    .bind(source)
    .fetch_one(&mut **tx)
    .await?;
    if waiting != 0 {
        return Err(StoreError::FailedPrecondition(format!(
            "{waiting} objects at Volume {id}'s previous source are still waiting for deletion: keep its credential (S3) or a Worker Host that maps it (file) until they are gone, then try again"
        )));
    }
    Ok(())
}

async fn unused(tx: &mut Transaction<'_, Any>, id: &str) -> Result<()> {
    let tags: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_tags WHERE volume=$1 AND retired_at_ms IS NULL",
    )
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    if tags != 0 {
        return Err(StoreError::FailedPrecondition(
            "a Tag keeps its work on this Volume".into(),
        ));
    }
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
    let row=sqlx::query("SELECT artifact_id,payload FROM supertag_v2_artifact_volume_copies WHERE (principal=$1 OR principal=$3) AND copy_id=$2").bind(principal).bind(id).bind(CAPTURE_PRINCIPAL).fetch_optional(&mut **tx).await?.ok_or_else(missing)?;
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
    /// Authorizes one object on the Tag's Volume for a live Attempt of the calling host. The key
    /// comes from the purpose and the Attempt's own Tag and Session, never from the request.
    pub async fn grant_volume_object(
        &self,
        host: &crate::HostAuthority,
        input: &VolumeObjectGrantRequest,
    ) -> Result<VolumeObjectGrant> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("a Volume grant names its Attempt"))?;
        let access = input.access();
        if !matches!(access, VolumeAccess::Write | VolumeAccess::Read) {
            return Err(invalid("a Volume grant is for writing or reading"));
        }
        match input.purpose() {
            VolumeObjectPurpose::SessionCheckpoint | VolumeObjectPurpose::NativeMemoryBlob => {}
            VolumeObjectPurpose::AcquiredFile if access == VolumeAccess::Read => {
                return self.grant_acquired_file(host, attempt, input).await;
            }
            _ => return Err(invalid("a Volume grant needs a purpose")),
        }
        let (mut tx, _) = self.write().await?;
        let row = crate::store::owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        crate::artifact_captures::running(&row, self.execution_now_ms())?;
        let task = crate::store::task_row(&row)?;
        let id = tag_volume_in(&mut tx, &task.tag_id, None)
            .await?
            .ok_or_else(|| StoreError::FailedPrecondition("the Tag names no Volume".into()))?;
        let volume = volume_in(&mut tx, &id).await?;
        if input.purpose() == VolumeObjectPurpose::NativeMemoryBlob {
            let (key, blob) = native_memory_object_in(&mut tx, &task, input).await?;
            if access == VolumeAccess::Write {
                crate::native_memory::pending_in(
                    &mut tx,
                    (&task.tag_id, &attempt.attempt_id),
                    (&id, &key, &blob),
                    self.execution_now_ms(),
                )
                .await?;
            }
            tx.commit().await?;
            return Ok(VolumeObjectGrant {
                volume: Some(volume),
                key,
                blob: Some(blob),
                presigned: None,
            });
        }
        let checkpoint = if access == VolumeAccess::Write {
            // The checkpoint this Attempt reserved, now marked as kept on the Volume.
            let reserved = crate::checkpoints::reservation_in(&mut tx, attempt)
                .await?
                .ok_or_else(|| {
                    StoreError::FailedPrecondition(
                        "reserve the checkpoint before its Volume grant".into(),
                    )
                })?;
            // On the Volume, any host that reaches it resumes the checkpoint: it has no holder to
            // wait for, and no host's reconcile deletes it.
            sqlx::query(
                "UPDATE supertag_v2_checkpoints SET volume_id=$1, holder_host_id=NULL WHERE attempt_id=$2 AND task_id=$3",
            )
            .bind(&id)
            .bind(&attempt.attempt_id)
            .bind(&attempt.task_id)
            .execute(&mut *tx)
            .await?;
            reserved
        } else {
            // The Session's current checkpoint, when it is on this Volume.
            crate::checkpoints::current_in(&mut tx, &row)
                .await?
                .filter(|current| {
                    current
                        .try_get::<Option<String>, _>("volume_id")
                        .ok()
                        .flatten()
                        .as_deref()
                        == Some(id.as_str())
                })
                .ok_or_else(|| {
                    StoreError::NotFound("the Session has no checkpoint on its Volume".into())
                })?
        };
        let reference = crate::checkpoints::reference_row(&checkpoint)?;
        tx.commit().await?;
        Ok(VolumeObjectGrant {
            volume: Some(volume),
            key: checkpoint_key(&task.tag_id, &task.session_id, &reference.sha256),
            blob: Some(BlobReference {
                sha256: reference.sha256,
                byte_length: reference.byte_length,
            }),
            presigned: None,
        })
    }

    /// A file of an artifact the Attempt acquired, read from the oldest verified copy on a
    /// registered Volume, for when the producing Worker Host cannot serve it.
    async fn grant_acquired_file(
        &self,
        host: &crate::HostAuthority,
        attempt: &InspectAttemptRequest,
        input: &VolumeObjectGrantRequest,
    ) -> Result<VolumeObjectGrant> {
        validate_artifact_path(&input.path).map_err(|error| invalid(error.message()))?;
        let mut tx = self.pool.begin().await?;
        let row = crate::store::owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        crate::artifact_captures::running(&row, self.execution_now_ms())?;
        let (capture, file) = self
            .acquired_source_in(
                &mut tx,
                &crate::AttemptAccess::new(host, attempt),
                &GetAcquiredArtifactFileRequest {
                    acquisition_id: input.acquisition_id.clone(),
                    path: input.path.clone(),
                },
            )
            .await?;
        let location = verified_location_in(&mut tx, &capture, &file)
            .await?
            .ok_or_else(|| StoreError::NotFound("the file has no verified Volume copy".into()))?;
        tx.commit().await?;
        Ok(VolumeObjectGrant {
            volume: location.volume,
            key: location.storage_key,
            blob: file.blob,
            presigned: None,
        })
    }

    pub async fn put_artifact_volume(
        &self,
        principal: &str,
        input: &PutArtifactVolumeRequest,
    ) -> Result<ArtifactVolume> {
        operator(principal)?;
        crate::store::resource_id("Volume ID", &input.volume_id)?;
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
                storage_movable(&mut tx, &input.volume_id, &input.source, !deleted).await?;
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
        if !input.dry_run
            && let Some(result) = prior(&mut tx, principal, &input.operation_id, &digest).await?
        {
            return Ok(result);
        }
        delete_in(&mut tx, &input.volume_id, input.expected_revision).await?;
        let result = DeleteArtifactVolumeResponse { deleted: true };
        if input.dry_run {
            // A dry run makes every check the deletion makes, then rolls it back unrecorded.
            tx.rollback().await?;
            return Ok(result);
        }
        record(&mut tx, principal, &input.operation_id, &digest, &result).await?;
        tx.commit().await?;
        Ok(result)
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
        let rows=sqlx::query(&format!("SELECT c.payload,c.created_order FROM supertag_v2_artifact_volume_copies c JOIN supertag_v2_artifact_captures a ON a.artifact_id=c.artifact_id JOIN supertag_v2_task_audience audience ON audience.task_id=a.task_id WHERE (c.principal=$1 OR c.principal=$5) AND {} AND ($2='' OR c.volume_id=$2) AND ($3=0 OR c.created_order<$3) ORDER BY c.created_order DESC LIMIT $4", crate::store::sees_owner_sql("audience.owner", "$1"))).bind(principal).bind(&input.volume_id).bind(before).bind(cap+1).bind(CAPTURE_PRINCIPAL).fetch_all(&mut *tx).await?;
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
    async fn grant_object(
        &self,
        request: Request<VolumeObjectGrantRequest>,
    ) -> std::result::Result<Response<VolumeObjectGrant>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .grant_volume_object(&host, request.get_ref())
                .await?,
        ))
    }
    async fn list_garbage(
        &self,
        request: Request<ListVolumeGarbageRequest>,
    ) -> std::result::Result<Response<ListVolumeGarbageResponse>, Status> {
        self.list_volume_garbage(request).await
    }
    async fn forget_garbage(
        &self,
        request: Request<ForgetVolumeGarbageRequest>,
    ) -> std::result::Result<Response<ForgetVolumeGarbageResponse>, Status> {
        self.forget_volume_garbage(request).await
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
