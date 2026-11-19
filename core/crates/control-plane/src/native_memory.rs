//! A Tag's harness-native memory: the files a harness keeps itself, such as Claude Code's
//! auto-memory.
//!
//! Worker Hosts keep the files, one store per Tag, harness, and audience, so a person's private
//! conversations never feed another person's turns. The Control Plane never holds the files. It
//! grants a turn its store with the Assignment ([`grant_in`]), records what each host reports
//! holding afterwards, and keeps a reset generation per Tag: an operator's reset drops the
//! records, and each host drops its older copies before it next runs one of the Tag's Tasks.
//!
//! A Tag that names a Volume keeps its stores there instead, as immutable blobs: the files and a
//! manifest naming them. The Control Plane holds only each store's head, the current manifest,
//! hands it out with the grant, and moves it by compare-and-set on the revision
//! ([`Store::advance_native_memory`]), so concurrent turns on any hosts merge, never overwrite.
use crate::AttemptAccess;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::*;

use crate::{
    Store, StoreError,
    store::{Result, invalid, lease_is_live, name, owned, task_row},
};

/// The most files and bytes a store may hold; the Worker Host refuses a turn's changes past them.
pub(crate) const MAX_FILES: u32 = 1_000;
pub(crate) const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// The store a turn's audience uses within its Tag and harness.
fn scope(audience: Option<&str>) -> String {
    match audience {
        None => "shared".to_owned(),
        Some(principal) => {
            let digest = format!("{:x}", Sha256::digest(principal.as_bytes()));
            format!("person-{}", &digest[..32])
        }
    }
}

async fn generation_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<u64> {
    let generation: i64 =
        sqlx::query_scalar("SELECT native_memory_generation FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag)
            .fetch_optional(&mut **tx)
            .await?
            .unwrap_or(0);
    Ok(generation.max(0) as u64)
}

/// The turn's audience when it may use native memory: its Tag keeps memory, an outside event
/// did not start it, and it has an audience. `Some(None)` is the shared store.
async fn audience_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<Option<Option<String>>> {
    if crate::memories::external_origin(task)
        || !crate::memories::tag_keeps_memory_in(tx, &task.tag_id).await?
    {
        return Ok(None);
    }
    crate::memories::turn_audience_in(tx, task).await
}

/// The harness whose store a turn uses, as its Volume keys name it.
fn store_harness(task: &Task) -> Option<&'static str> {
    task.attempt_execution
        .as_ref()
        .and_then(|execution| supertag_protocol::checkpoint_harness(execution.harness_kind()))
}

/// The turn's store on its Tag's current Volume: that Volume, and the store's head there when it
/// has one. `None` when the Tag names no Volume or the turn's harness keeps no native memory.
async fn volume_store_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    audience: Option<&str>,
) -> Result<Option<(String, Option<NativeMemoryVolumeHead>)>> {
    let Some(harness) = store_harness(task) else {
        return Ok(None);
    };
    let Some(volume) = crate::artifact_volumes::tag_volume_in(tx, &task.tag_id, None).await? else {
        return Ok(None);
    };
    let head = sqlx::query(
        "SELECT revision,manifest_sha256,manifest_bytes FROM supertag_v2_native_memory_volume_heads
         WHERE tag_id=$1 AND harness=$2 AND audience_principal=$3 AND volume_id=$4",
    )
    .bind(&task.tag_id)
    .bind(harness)
    .bind(audience.unwrap_or(""))
    .bind(&volume)
    .fetch_optional(&mut **tx)
    .await?
    .map(|row| {
        Ok::<_, StoreError>(NativeMemoryVolumeHead {
            revision: row.try_get::<i64, _>("revision")?.max(0) as u64,
            manifest: Some(BlobReference {
                sha256: row.try_get("manifest_sha256")?,
                byte_length: row.try_get::<i64, _>("manifest_bytes")?.max(0) as u64,
            }),
        })
    })
    .transpose()?;
    Ok(Some((volume, head)))
}

/// The native memory store a claimed turn may use, if any.
pub(crate) async fn grant_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
) -> Result<Option<NativeMemoryGrant>> {
    let Some(audience) = audience_in(tx, task).await? else {
        return Ok(None);
    };
    let volume_head = volume_store_in(tx, task, audience.as_deref())
        .await?
        .and_then(|(_, head)| head);
    Ok(Some(NativeMemoryGrant {
        scope: scope(audience.as_deref()),
        reset_generation: generation_in(tx, &task.tag_id).await?,
        volume_head,
    }))
}

fn store_row(row: &AnyRow) -> Result<NativeMemoryStore> {
    let audience: String = row.try_get("audience_principal")?;
    Ok(NativeMemoryStore {
        tag_id: row.try_get("tag_id")?,
        harness: row.try_get("harness")?,
        audience: (!audience.is_empty()).then_some(audience),
        host_id: row.try_get("host_id")?,
        revision: row.try_get::<i64, _>("revision")?.max(0) as u64,
        files: row
            .try_get::<i64, _>("files")?
            .clamp(0, i64::from(u32::MAX)) as u32,
        bytes: row.try_get::<i64, _>("bytes")?.max(0) as u64,
        digest: row.try_get("digest")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
        task_id: row.try_get("task_id")?,
        volume_id: String::new(),
    })
}

fn head_row(row: &AnyRow) -> Result<NativeMemoryStore> {
    let audience: String = row.try_get("audience_principal")?;
    Ok(NativeMemoryStore {
        tag_id: row.try_get("tag_id")?,
        harness: row.try_get("harness")?,
        audience: (!audience.is_empty()).then_some(audience),
        host_id: String::new(),
        revision: row.try_get::<i64, _>("revision")?.max(0) as u64,
        files: row
            .try_get::<i64, _>("files")?
            .clamp(0, i64::from(u32::MAX)) as u32,
        bytes: row.try_get::<i64, _>("bytes")?.max(0) as u64,
        digest: row.try_get("manifest_sha256")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
        task_id: row.try_get("task_id")?,
        volume_id: row.try_get("volume_id")?,
    })
}

/// The Tag's stores, newest first: each host's copy, and each store on a Volume.
async fn stores_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<Vec<NativeMemoryStore>> {
    let mut stores = sqlx::query(
        "SELECT * FROM supertag_v2_native_memory_stores WHERE tag_id=$1
         ORDER BY updated_at_ms DESC, harness, audience_principal, host_id",
    )
    .bind(tag)
    .fetch_all(&mut **tx)
    .await?
    .iter()
    .map(store_row)
    .collect::<Result<Vec<_>>>()?;
    for row in sqlx::query(
        "SELECT * FROM supertag_v2_native_memory_volume_heads WHERE tag_id=$1
         ORDER BY updated_at_ms DESC, harness, audience_principal",
    )
    .bind(tag)
    .fetch_all(&mut **tx)
    .await?
    {
        stores.push(head_row(&row)?);
    }
    stores.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
    Ok(stores)
}

/// One object a store on a Volume names: its Volume, key, and bytes.
struct NamedObject {
    volume_id: String,
    storage_key: String,
    blob: BlobReference,
}

/// The objects the stores of `tag` name, or one store's when `store` gives its harness and
/// audience.
async fn named_objects_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    store: Option<(&str, &str)>,
) -> Result<Vec<NamedObject>> {
    let rows = sqlx::query(
        "SELECT volume_id,storage_key,sha256,byte_length FROM supertag_v2_native_memory_volume_objects
         WHERE tag_id=$1 AND ($2='' OR (harness=$3 AND audience_principal=$4))",
    )
    .bind(tag)
    .bind(if store.is_some() { "store" } else { "" })
    .bind(store.map_or("", |(harness, _)| harness))
    .bind(store.map_or("", |(_, audience)| audience))
    .fetch_all(&mut **tx)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(NamedObject {
                volume_id: row.try_get("volume_id")?,
                storage_key: row.try_get("storage_key")?,
                blob: BlobReference {
                    sha256: row.try_get("sha256")?,
                    byte_length: row.try_get::<i64, _>("byte_length")?.max(0) as u64,
                },
            })
        })
        .collect()
}

/// Makes `objects` the store's whole object set on `volume`: what it named before and no longer
/// does goes to Volume garbage, and what it names again leaves the queue.
async fn name_objects_in(
    tx: &mut Transaction<'_, Any>,
    (tag, harness, audience, scope): (&str, &str, &str, &str),
    volume: &str,
    objects: &[BlobReference],
) -> Result<()> {
    let keyed: Vec<(String, &BlobReference)> = objects
        .iter()
        .map(|blob| {
            (
                crate::artifact_volumes::native_memory_key(tag, harness, scope, &blob.sha256),
                blob,
            )
        })
        .collect();
    for old in named_objects_in(tx, tag, Some((harness, audience))).await? {
        let kept = old.volume_id == volume && keyed.iter().any(|(key, _)| key == &old.storage_key);
        if !kept {
            crate::volume_garbage::queue_native_object_in(
                tx,
                tag,
                &old.volume_id,
                &old.storage_key,
                &old.blob,
            )
            .await?;
        }
    }
    sqlx::query(
        "DELETE FROM supertag_v2_native_memory_volume_objects
         WHERE tag_id=$1 AND harness=$2 AND audience_principal=$3",
    )
    .bind(tag)
    .bind(harness)
    .bind(audience)
    .execute(&mut **tx)
    .await?;
    for (key, blob) in keyed {
        crate::volume_garbage::unqueue_native_object_in(tx, volume, &key).await?;
        sqlx::query(
            "DELETE FROM supertag_v2_native_memory_pending_objects WHERE volume_id=$1 AND storage_key=$2",
        )
        .bind(volume)
        .bind(&key)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO supertag_v2_native_memory_volume_objects
             (tag_id,harness,audience_principal,volume_id,storage_key,sha256,byte_length)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        )
        .bind(tag)
        .bind(harness)
        .bind(audience)
        .bind(volume)
        .bind(&key)
        .bind(&blob.sha256)
        .bind(blob.byte_length as i64)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// How long after its grant an object no store names may still be named: its turn may be about to
/// move the head. Past this, and once the writing Attempt no longer runs, it is garbage.
const PENDING_GRACE_MS: i64 = 60 * 60 * 1000;
/// Pending objects one sweep pass looks at.
const PENDING_SWEEP_BATCH: i64 = 500;

/// Records an object a host was granted to write: until a store names it, the sweep may send it
/// to Volume garbage. Writing it again takes it out of the queue, so bytes a later turn reuses
/// are never collected under it.
pub(crate) async fn pending_in(
    tx: &mut Transaction<'_, Any>,
    (tag, attempt): (&str, &str),
    (volume, key, blob): (&str, &str, &BlobReference),
    now: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO supertag_v2_native_memory_pending_objects
           (volume_id,storage_key,sha256,byte_length,tag_id,attempt_id,granted_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (volume_id,storage_key) DO UPDATE SET
           attempt_id=excluded.attempt_id, granted_at_ms=excluded.granted_at_ms",
    )
    .bind(volume)
    .bind(key)
    .bind(&blob.sha256)
    .bind(blob.byte_length as i64)
    .bind(tag)
    .bind(attempt)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    crate::volume_garbage::unqueue_native_object_in(tx, volume, key).await
}

/// Retiring a Tag drops its records. Its hosts' copies go when the hosts next see a reset or
/// with their state.
pub(crate) async fn retire_tag_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<()> {
    // Every object the Tag's stores named on a Volume goes to Volume garbage.
    for object in named_objects_in(tx, tag, None).await? {
        crate::volume_garbage::queue_native_object_in(
            tx,
            tag,
            &object.volume_id,
            &object.storage_key,
            &object.blob,
        )
        .await?;
    }
    for table in [
        "supertag_v2_native_memory_volume_objects",
        "supertag_v2_native_memory_stores",
        "supertag_v2_native_memory_volume_heads",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE tag_id=$1"))
            .bind(tag)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

impl Store {
    /// The records of a Tag's native memory the principal sees: an operator sees all of them, a
    /// client the shared stores and its own.
    pub async fn native_memory_stores(
        &self,
        principal: &str,
        tag: &str,
    ) -> Result<Vec<NativeMemoryStore>> {
        name("Tag ID", tag)?;
        let mut tx = self.pool.begin().await?;
        let stores = stores_in(&mut tx, tag).await?;
        tx.commit().await?;
        Ok(stores
            .into_iter()
            .filter(|store| {
                crate::store::sees_owner(principal, store.audience.as_deref().unwrap_or(""))
            })
            .collect())
    }

    /// Operators only: drops a Tag's native memory records and starts a new reset generation.
    pub async fn reset_native_memory(
        &self,
        principal: &str,
        input: &ResetNativeMemoryRequest,
    ) -> Result<ResetNativeMemoryResponse> {
        crate::policy::operator(principal)?;
        name("Tag ID", &input.tag_id)?;
        let (mut tx, _) = self.write().await?;
        let found: Option<String> =
            sqlx::query_scalar("SELECT tag_id FROM supertag_v2_tags WHERE tag_id=$1")
                .bind(&input.tag_id)
                .fetch_optional(&mut *tx)
                .await?;
        if found.is_none() {
            return Err(StoreError::NotFound(format!(
                "Tag {} was not found",
                input.tag_id
            )));
        }
        let stores = stores_in(&mut tx, &input.tag_id).await?;
        retire_tag_in(&mut tx, &input.tag_id).await?;
        sqlx::query("UPDATE supertag_v2_tags SET native_memory_generation=native_memory_generation+1 WHERE tag_id=$1")
            .bind(&input.tag_id)
            .execute(&mut *tx)
            .await?;
        let reset_generation = generation_in(&mut tx, &input.tag_id).await?;
        tx.commit().await?;
        Ok(ResetNativeMemoryResponse {
            stores,
            reset_generation,
        })
    }

    /// Sends native memory objects a host wrote but no store named to Volume garbage, once the
    /// writing Attempt no longer runs and [`PENDING_GRACE_MS`] has passed. Returns how many.
    pub async fn sweep_native_memory_objects(&self) -> Result<u64> {
        let cutoff = self.execution_now_ms() - PENDING_GRACE_MS;
        let (mut tx, _) = self.write().await?;
        let rows = sqlx::query(
            "SELECT p.volume_id,p.storage_key,p.sha256,p.byte_length,p.tag_id,
                    EXISTS (SELECT 1 FROM supertag_v2_native_memory_volume_objects o
                            WHERE o.volume_id=p.volume_id AND o.storage_key=p.storage_key) AS named
             FROM supertag_v2_native_memory_pending_objects p
             WHERE p.granted_at_ms < $1
               AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks t
                               WHERE t.attempt_id=p.attempt_id AND t.state IN ($2,$3))
             ORDER BY p.granted_at_ms LIMIT $4",
        )
        .bind(cutoff)
        .bind(TaskState::Claimed as i64)
        .bind(TaskState::Running as i64)
        .bind(PENDING_SWEEP_BATCH)
        .fetch_all(&mut *tx)
        .await?;
        let mut queued = 0;
        for row in &rows {
            let volume: String = row.try_get("volume_id")?;
            let key: String = row.try_get("storage_key")?;
            let named = match row.try_get::<bool, _>("named") {
                Ok(named) => named,
                Err(_) => row.try_get::<i64, _>("named")? != 0,
            };
            if !named {
                let blob = BlobReference {
                    sha256: row.try_get("sha256")?,
                    byte_length: row.try_get::<i64, _>("byte_length")?.max(0) as u64,
                };
                let tag: String = row.try_get("tag_id")?;
                crate::volume_garbage::queue_native_object_in(&mut tx, &tag, &volume, &key, &blob)
                    .await?;
                queued += 1;
            }
            sqlx::query(
                "DELETE FROM supertag_v2_native_memory_pending_objects WHERE volume_id=$1 AND storage_key=$2",
            )
            .bind(&volume)
            .bind(&key)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(queued)
    }

    /// Moves the turn's store on its Tag's Volume to the manifest the host wrote, if the store is
    /// still at `expected_revision`. Otherwise nothing changes and the current head comes back,
    /// so the host merges onto it and tries again.
    pub async fn advance_native_memory(
        &self,
        authority: &AttemptAccess,
        input: &AdvanceNativeMemoryRequest,
    ) -> Result<AdvanceNativeMemoryResponse> {
        let host = authority.host();
        let attempt = authority.lease();
        let manifest = input
            .manifest
            .clone()
            .filter(|blob| {
                supertag_protocol::valid_sha256(&blob.sha256)
                    && blob.byte_length <= supertag_protocol::MAX_CHECKPOINT_BYTES as u64
            })
            .ok_or_else(|| invalid("a native memory manifest needs a valid blob"))?;
        if input.files > MAX_FILES || input.bytes > MAX_BYTES {
            return Err(invalid("native memory is over its size limit"));
        }
        // Without its object list a store's files would be deleted as garbage.
        if input.objects.len() > MAX_FILES as usize
            || (input.files > 0 && input.objects.is_empty())
            || input.objects.iter().any(|blob| {
                !supertag_protocol::valid_sha256(&blob.sha256)
                    || blob.byte_length > supertag_protocol::MAX_CHECKPOINT_BYTES as u64
            })
        {
            return Err(invalid("a native memory head names its objects"));
        }
        let now = self.execution_now_ms();
        let (mut tx, _) = self.write().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        if row.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&row, now)?
        {
            return Err(StoreError::FailedPrecondition(
                "moving native memory requires a live running Attempt".into(),
            ));
        }
        let task = task_row(&row)?;
        let Some(audience) = audience_in(&mut tx, &task).await? else {
            return Err(StoreError::PermissionDenied);
        };
        if generation_in(&mut tx, &task.tag_id).await? != input.reset_generation {
            return Err(StoreError::FailedPrecondition(
                "the Tag's native memory was reset during this turn".into(),
            ));
        }
        let (volume, head) = volume_store_in(&mut tx, &task, audience.as_deref())
            .await?
            .ok_or_else(|| {
                StoreError::FailedPrecondition(
                    "this turn keeps no native memory on a Volume".into(),
                )
            })?;
        let current = head.as_ref().map_or(0, |head| head.revision);
        if current != input.expected_revision {
            tx.commit().await?;
            return Ok(AdvanceNativeMemoryResponse {
                advanced: false,
                head,
            });
        }
        let revision = current
            .checked_add(1)
            .and_then(|revision| i64::try_from(revision).ok())
            .ok_or_else(|| invalid("native memory revision is out of range"))?;
        let harness = store_harness(&task).unwrap_or("custom");
        // A head on another Volume is a store this Tag no longer uses; the new one replaces it.
        sqlx::query(
            "INSERT INTO supertag_v2_native_memory_volume_heads
               (tag_id,harness,audience_principal,volume_id,revision,manifest_sha256,manifest_bytes,files,bytes,updated_at_ms,task_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (tag_id,harness,audience_principal) DO UPDATE SET
               volume_id=excluded.volume_id, revision=excluded.revision,
               manifest_sha256=excluded.manifest_sha256, manifest_bytes=excluded.manifest_bytes,
               files=excluded.files, bytes=excluded.bytes, updated_at_ms=excluded.updated_at_ms,
               task_id=excluded.task_id",
        )
        .bind(&task.tag_id)
        .bind(harness)
        .bind(audience.as_deref().unwrap_or(""))
        .bind(&volume)
        .bind(revision)
        .bind(&manifest.sha256)
        .bind(manifest.byte_length as i64)
        .bind(i64::from(input.files))
        .bind(input.bytes as i64)
        .bind(now)
        .bind(&task.task_id)
        .execute(&mut *tx)
        .await?;
        let mut objects = input.objects.clone();
        objects.push(manifest.clone());
        objects.sort_by(|left, right| left.sha256.cmp(&right.sha256));
        objects.dedup_by(|left, right| left.sha256 == right.sha256);
        let audience_key = audience.as_deref().unwrap_or("");
        name_objects_in(
            &mut tx,
            (
                &task.tag_id,
                harness,
                audience_key,
                &scope(audience.as_deref()),
            ),
            &volume,
            &objects,
        )
        .await?;
        tx.commit().await?;
        Ok(AdvanceNativeMemoryResponse {
            advanced: true,
            head: Some(NativeMemoryVolumeHead {
                revision: revision as u64,
                manifest: Some(manifest),
            }),
        })
    }

    /// A Worker Host records what it holds of the store its running turn was granted. A report
    /// made under an older reset generation changes nothing.
    pub async fn report_native_memory(
        &self,
        authority: &AttemptAccess,
        input: &ReportNativeMemoryRequest,
    ) -> Result<()> {
        let host = authority.host();
        let attempt = authority.lease();
        if input.files > MAX_FILES || input.bytes > MAX_BYTES {
            return Err(invalid("native memory is over its size limit"));
        }
        if input.digest.len() != 64 || !input.digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid("native memory digest must be a SHA-256 hex digest"));
        }
        let revision = i64::try_from(input.revision)
            .map_err(|_| invalid("native memory revision is out of range"))?;
        let now = self.execution_now_ms();
        let (mut tx, _) = self.write().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        if row.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&row, now)?
        {
            return Err(StoreError::FailedPrecondition(
                "reporting native memory requires a live running Attempt".into(),
            ));
        }
        let task = task_row(&row)?;
        let Some(audience) = audience_in(&mut tx, &task).await? else {
            return Err(StoreError::PermissionDenied);
        };
        if generation_in(&mut tx, &task.tag_id).await? != input.reset_generation {
            tx.commit().await?;
            return Ok(());
        }
        let harness = crate::policy::harness_wire_name(task.harness_kind()).unwrap_or("custom");
        sqlx::query(
            "INSERT INTO supertag_v2_native_memory_stores
               (tag_id,harness,audience_principal,host_id,revision,files,bytes,digest,updated_at_ms,task_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (tag_id,harness,audience_principal,host_id) DO UPDATE SET
               revision=excluded.revision, files=excluded.files, bytes=excluded.bytes,
               digest=excluded.digest, updated_at_ms=excluded.updated_at_ms, task_id=excluded.task_id",
        )
        .bind(&task.tag_id)
        .bind(harness)
        .bind(audience.as_deref().unwrap_or(""))
        .bind(host.id())
        .bind(revision)
        .bind(i64::from(input.files))
        .bind(input.bytes as i64)
        .bind(input.digest.to_ascii_lowercase())
        .bind(now)
        .bind(&task.task_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::scope;

    #[test]
    fn private_stores_name_a_digest_never_the_person() {
        assert_eq!(scope(None), "shared");
        let private = scope(Some("client:alice"));
        assert!(
            private.starts_with("person-") && private.len() == 39,
            "{private}"
        );
        assert!(!private.contains("alice"));
        assert_ne!(private, scope(Some("client:bob")));
        assert_eq!(private, scope(Some("client:alice")));
    }
}
