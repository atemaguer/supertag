//! Objects on a Volume that nothing keeps any more. Dropping a checkpoint row that a Worker Host
//! wrote to a Volume queues its object here; the Control Plane deletes an S3 Volume's objects
//! itself, and a Worker Host that maps a file Volume deletes that Volume's. An object stays while a
//! checkpoint row of its Session still names the same bytes on the same Volume, as a later turn
//! that wrote identical bytes reuses the key.
use crate::{
    ControlPlane, HostAuthority, Store,
    artifact_volumes::checkpoint_key,
    store::{Result, invalid, name},
};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{
    v2::*,
    volumes::{file_volume_path, s3_volume_source},
};
use tonic::{Request, Response, Status};

/// The most objects one page lists.
const PAGE: u32 = 1000;
const DEFAULT_PAGE: u32 = 100;

/// Garbage nothing keeps: `g` is the garbage row. A checkpoint stays while a checkpoint row of its
/// Session still names the same bytes on the same Volume; a native memory object stays while a
/// store on that Volume still names its key.
const UNKEPT: &str = "((g.kind='checkpoint' AND NOT EXISTS (SELECT 1 FROM supertag_v2_checkpoints c
    JOIN supertag_v2_tasks t ON t.task_id=c.task_id
    WHERE c.volume_id=g.volume_id AND c.sha256=g.sha256
      AND t.tag_id=g.tag_id AND t.session_id=g.session_id))
  OR (g.kind='native-memory' AND NOT EXISTS (SELECT 1 FROM supertag_v2_native_memory_volume_objects o
    WHERE o.volume_id=g.volume_id AND o.storage_key=g.storage_key)))";

/// Queues one native memory object a store no longer names, when its Volume is still registered.
pub(crate) async fn queue_native_object_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    volume_id: &str,
    storage_key: &str,
    blob: &BlobReference,
) -> Result<()> {
    let Some(source): Option<String> = sqlx::query_scalar(
        "SELECT source FROM supertag_v2_artifact_volumes WHERE volume_id=$1 AND deleted=0",
    )
    .bind(volume_id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO supertag_v2_volume_garbage
         (volume_id,source,storage_key,sha256,byte_length,tag_id,session_id,queued_at_ms,kind)
         VALUES ($1,$2,$3,$4,$5,$6,'',$7,'native-memory')
         ON CONFLICT(volume_id,storage_key) DO UPDATE SET source=excluded.source,
           queued_at_ms=excluded.queued_at_ms",
    )
    .bind(volume_id)
    .bind(source)
    .bind(storage_key)
    .bind(&blob.sha256)
    .bind(blob.byte_length as i64)
    .bind(tag)
    .bind(now_ms())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// A native memory object a store names again leaves the queue.
pub(crate) async fn unqueue_native_object_in(
    tx: &mut Transaction<'_, Any>,
    volume_id: &str,
    storage_key: &str,
) -> Result<()> {
    sqlx::query(
        "DELETE FROM supertag_v2_volume_garbage
         WHERE volume_id=$1 AND storage_key=$2 AND kind='native-memory'",
    )
    .bind(volume_id)
    .bind(storage_key)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// Queues the object of `attempt`'s checkpoint, when a host wrote it to a Volume that is still
/// registered, before its row goes.
pub(crate) async fn queue_checkpoint_in(
    tx: &mut Transaction<'_, Any>,
    attempt: &str,
) -> Result<()> {
    let Some(row) = sqlx::query(
        "SELECT c.volume_id,c.sha256,c.byte_length,t.tag_id,t.session_id,v.source
         FROM supertag_v2_checkpoints c
         JOIN supertag_v2_tasks t ON t.task_id=c.task_id
         JOIN supertag_v2_artifact_volumes v ON v.volume_id=c.volume_id AND v.deleted=0
         WHERE c.attempt_id=$1",
    )
    .bind(attempt)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(());
    };
    let tag: String = row.try_get("tag_id")?;
    let session: String = row.try_get("session_id")?;
    let sha256: String = row.try_get("sha256")?;
    sqlx::query(
        "INSERT INTO supertag_v2_volume_garbage
         (volume_id,source,storage_key,sha256,byte_length,tag_id,session_id,queued_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(volume_id,storage_key) DO UPDATE SET source=excluded.source,
           queued_at_ms=excluded.queued_at_ms",
    )
    .bind(row.try_get::<String, _>("volume_id")?)
    .bind(row.try_get::<String, _>("source")?)
    .bind(checkpoint_key(&tag, &session, &sha256))
    .bind(&sha256)
    .bind(row.try_get::<i64, _>("byte_length")?)
    .bind(&tag)
    .bind(&session)
    .bind(now_ms())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn object(row: &AnyRow) -> Result<VolumeGarbageObject> {
    Ok(VolumeGarbageObject {
        key: row.try_get("storage_key")?,
        blob: Some(BlobReference {
            sha256: row.try_get("sha256")?,
            byte_length: row.try_get::<i64, _>("byte_length")? as u64,
        }),
        queued_at_ms: row.try_get("queued_at_ms")?,
    })
}

fn page(limit: u32) -> Result<u32> {
    match limit {
        0 => Ok(DEFAULT_PAGE),
        1..=PAGE => Ok(limit),
        _ => Err(invalid("limit must be between 1 and 1000")),
    }
}

/// A file Volume's identity as a host maps it.
fn file_volume(volume_id: &str, source: &str) -> Result<()> {
    name("Volume ID", volume_id)?;
    file_volume_path(source).map_err(|status| invalid(status.message()))?;
    Ok(())
}

impl Store {
    /// A page of a file Volume's garbage at `source`, oldest first, for a host that maps it.
    pub async fn list_volume_garbage(
        &self,
        _host: &HostAuthority,
        input: &ListVolumeGarbageRequest,
    ) -> Result<ListVolumeGarbageResponse> {
        file_volume(&input.volume_id, &input.source)?;
        let limit = page(input.limit)?;
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query(&format!(
            "SELECT g.storage_key,g.sha256,g.byte_length,g.queued_at_ms
             FROM supertag_v2_volume_garbage g
             WHERE g.volume_id=$1 AND g.source=$2 AND {UNKEPT}
             ORDER BY g.queued_at_ms,g.storage_key LIMIT $3"
        ))
        .bind(&input.volume_id)
        .bind(&input.source)
        .bind(i64::from(limit))
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(ListVolumeGarbageResponse {
            objects: rows.iter().map(object).collect::<Result<_>>()?,
        })
    }

    /// Forgets a file Volume's objects a host deleted.
    pub async fn forget_volume_garbage(
        &self,
        _host: &HostAuthority,
        input: &ForgetVolumeGarbageRequest,
    ) -> Result<ForgetVolumeGarbageResponse> {
        file_volume(&input.volume_id, &input.source)?;
        self.forget_garbage(input).await?;
        Ok(ForgetVolumeGarbageResponse {})
    }

    /// Up to `limit` objects on S3 Volumes for the Control Plane to delete, oldest first, each as
    /// the request that forgets it.
    pub async fn take_s3_volume_garbage(
        &self,
        limit: u32,
    ) -> Result<Vec<ForgetVolumeGarbageRequest>> {
        let limit = page(limit)?;
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query(&format!(
            "SELECT g.volume_id,g.source,g.storage_key,g.sha256,g.byte_length,g.queued_at_ms
             FROM supertag_v2_volume_garbage g
             WHERE g.source LIKE 's3://%' AND {UNKEPT}
             ORDER BY g.queued_at_ms,g.storage_key LIMIT $1"
        ))
        .bind(i64::from(limit))
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        rows.iter()
            .map(|row| {
                Ok(ForgetVolumeGarbageRequest {
                    volume_id: row.try_get("volume_id")?,
                    source: row.try_get("source")?,
                    objects: vec![object(row)?],
                })
            })
            .collect()
    }

    /// Forgets objects the Control Plane deleted from an S3 Volume.
    pub async fn forget_s3_volume_garbage(&self, input: &ForgetVolumeGarbageRequest) -> Result<()> {
        name("Volume ID", &input.volume_id)?;
        s3_volume_source(&input.source).map_err(|status| invalid(status.message()))?;
        self.forget_garbage(input).await
    }

    /// Forgets exactly the listed objects: one queued again since it was listed stays.
    async fn forget_garbage(&self, input: &ForgetVolumeGarbageRequest) -> Result<()> {
        if input.objects.len() > PAGE as usize {
            return Err(invalid("at most 1000 objects at once"));
        }
        let (mut tx, _) = self.write().await?;
        for object in &input.objects {
            sqlx::query(
                "DELETE FROM supertag_v2_volume_garbage
                 WHERE volume_id=$1 AND source=$2 AND storage_key=$3 AND queued_at_ms=$4",
            )
            .bind(&input.volume_id)
            .bind(&input.source)
            .bind(&object.key)
            .bind(object.queued_at_ms)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

impl ControlPlane {
    /// Up to `limit` S3 Volume objects to delete; see [`Store::take_s3_volume_garbage`].
    pub async fn take_s3_volume_garbage(
        &self,
        limit: u32,
    ) -> anyhow::Result<Vec<ForgetVolumeGarbageRequest>> {
        Ok(self.store.take_s3_volume_garbage(limit).await?)
    }

    /// Forgets S3 Volume objects the Control Plane deleted.
    pub async fn forget_s3_volume_garbage(
        &self,
        input: &ForgetVolumeGarbageRequest,
    ) -> anyhow::Result<()> {
        Ok(self.store.forget_s3_volume_garbage(input).await?)
    }

    pub(crate) async fn list_volume_garbage(
        &self,
        request: Request<ListVolumeGarbageRequest>,
    ) -> std::result::Result<Response<ListVolumeGarbageResponse>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .list_volume_garbage(&host, request.get_ref())
                .await?,
        ))
    }

    pub(crate) async fn forget_volume_garbage(
        &self,
        request: Request<ForgetVolumeGarbageRequest>,
    ) -> std::result::Result<Response<ForgetVolumeGarbageResponse>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .forget_volume_garbage(&host, request.get_ref())
                .await?,
        ))
    }
}
