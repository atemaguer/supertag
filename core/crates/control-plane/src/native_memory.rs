//! A Tag's harness-native memory: the files a harness keeps itself, such as Claude Code's
//! auto-memory.
//!
//! Worker Hosts keep the files, one store per Tag, harness, and audience, so a person's private
//! conversations never feed another person's turns. The Control Plane never holds the files. It
//! grants a turn its store with the Assignment ([`grant_in`]), records what each host reports
//! holding afterwards, and keeps a reset generation per Tag: an operator's reset drops the
//! records, and each host drops its older copies before it next runs one of the Tag's Tasks.
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::*;

use crate::{
    HostAuthority, Store, StoreError,
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

/// The native memory store a claimed turn may use, if any.
pub(crate) async fn grant_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
) -> Result<Option<NativeMemoryGrant>> {
    let Some(audience) = audience_in(tx, task).await? else {
        return Ok(None);
    };
    Ok(Some(NativeMemoryGrant {
        scope: scope(audience.as_deref()),
        reset_generation: generation_in(tx, &task.tag_id).await?,
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
    })
}

async fn stores_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<Vec<NativeMemoryStore>> {
    sqlx::query(
        "SELECT * FROM supertag_v2_native_memory_stores WHERE tag_id=$1
         ORDER BY updated_at_ms DESC, harness, audience_principal, host_id",
    )
    .bind(tag)
    .fetch_all(&mut **tx)
    .await?
    .iter()
    .map(store_row)
    .collect()
}

/// Retiring a Tag drops its records. Its hosts' copies go when the hosts next see a reset or
/// with their state.
pub(crate) async fn retire_tag_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<()> {
    sqlx::query("DELETE FROM supertag_v2_native_memory_stores WHERE tag_id=$1")
        .bind(tag)
        .execute(&mut **tx)
        .await?;
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

    /// A Worker Host records what it holds of the store its running turn was granted. A report
    /// made under an older reset generation changes nothing.
    pub async fn report_native_memory(
        &self,
        host: &HostAuthority,
        input: &ReportNativeMemoryRequest,
    ) -> Result<()> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
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
