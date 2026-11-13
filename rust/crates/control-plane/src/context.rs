//! Durable resolution of admitted context, separate from immutable catalog policy.
use crate::{
    HostAuthority, Store, StoreError,
    store::{Result, invalid, lease_is_live, owned, task_in},
};
use prost::Message;
use sqlx::{Any, Row, Transaction, any::AnyRow};
use std::collections::{BTreeMap, BTreeSet};
use supertag_protocol::v2::*;

pub(crate) fn task_supported(task: &Task, contracts: &[ContextContract]) -> bool {
    task.policy_snapshot.as_ref().is_none_or(|snapshot| {
        snapshot.context_sets.iter().all(|set| {
            set.items.iter().all(|item| {
                crate::artifact_context::resolved(item)
                    || !item.required
                    || contracts.iter().any(|contract| {
                        contract.r#type == item.r#type && contract.version == item.version
                    })
            })
        })
    })
}
impl Store {
    pub async fn get_context_pins(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
    ) -> Result<ContextResolutionManifest> {
        let mut tx = self.pool.begin().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        running(&row, self.execution_now_ms())?;
        let manifest = manifest_in(&mut tx, &attempt.task_id)
            .await?
            .unwrap_or_default();
        tx.commit().await?;
        Ok(manifest)
    }
    pub async fn commit_context_resolution(
        &self,
        host: &HostAuthority,
        input: &CommitContextResolutionRequest,
    ) -> Result<ContextResolutionManifest> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("context resolution requires Attempt identity"))?;
        let mut manifest = input
            .manifest
            .clone()
            .ok_or_else(|| invalid("context resolution requires a manifest"))?;
        if manifest.encoded_len() > 128 * 1024 {
            return Err(invalid("context resolution manifest exceeds size limit"));
        }
        manifest
            .pins
            .sort_by(|a, b| (&a.set_id, &a.item_id).cmp(&(&b.set_id, &b.item_id)));
        manifest
            .omissions
            .sort_by(|a, b| (&a.set_id, &a.item_id).cmp(&(&b.set_id, &b.item_id)));
        let (mut tx, _) = self.write().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let task = task_in(&mut tx, &attempt.task_id).await?;
        validate(&task, &manifest)?;
        if let Some(prior) = manifest_in(&mut tx, &attempt.task_id).await? {
            if prior != manifest {
                return Err(StoreError::Conflict(
                    "Task context was already resolved differently".into(),
                ));
            }
            let receipt: Option<String> = sqlx::query_scalar(
                "SELECT task_id FROM supertag_v2_attempt_context_resolutions WHERE attempt_id=$1",
            )
            .bind(&attempt.attempt_id)
            .fetch_optional(&mut *tx)
            .await?;
            if receipt.as_deref() == Some(&attempt.task_id) {
                tx.commit().await?;
                return Ok(prior);
            }
        }
        running(&row, self.execution_now_ms())?;
        sqlx::query("INSERT INTO supertag_v2_context_resolutions (task_id,first_attempt_id,manifest) VALUES ($1,$2,$3) ON CONFLICT(task_id) DO NOTHING").bind(&attempt.task_id).bind(&attempt.attempt_id).bind(manifest.encode_to_vec()).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_attempt_context_resolutions (attempt_id,task_id) VALUES ($1,$2)").bind(&attempt.attempt_id).bind(&attempt.task_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(manifest)
    }
}
fn running(row: &AnyRow, now: i64) -> Result<()> {
    if row.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(row, now)? {
        return Err(StoreError::FailedPrecondition(
            "context resolution requires a live running Attempt".into(),
        ));
    }
    Ok(())
}
async fn manifest_in(
    tx: &mut Transaction<'_, Any>,
    task: &str,
) -> Result<Option<ContextResolutionManifest>> {
    let bytes: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT manifest FROM supertag_v2_context_resolutions WHERE task_id=$1")
            .bind(task)
            .fetch_optional(&mut **tx)
            .await?;
    bytes
        .map(|bytes| {
            ContextResolutionManifest::decode(bytes.as_slice()).map_err(|_| {
                StoreError::FailedPrecondition("stored context resolution is invalid".into())
            })
        })
        .transpose()
}
fn validate(task: &Task, manifest: &ContextResolutionManifest) -> Result<()> {
    let mut items = BTreeMap::new();
    if let Some(snapshot) = &task.policy_snapshot {
        for set in &snapshot.context_sets {
            for item in &set.items {
                if crate::artifact_context::resolved(item) {
                    continue;
                }
                items.insert((set.set_id.as_str(), item.item_id.as_str()), item);
            }
        }
    }
    if manifest.pins.len() + manifest.omissions.len() != items.len() {
        return Err(invalid(
            "context resolution must cover every admitted Context Item exactly once",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut references = BTreeMap::new();
    for pin in &manifest.pins {
        let key = (pin.set_id.as_str(), pin.item_id.as_str());
        let item = items
            .get(&key)
            .ok_or_else(|| invalid("context pin names an unadmitted Context Item"))?;
        if !seen.insert(key)
            || item.item_key != pin.item_key
            || item.r#type != "supertag/skill"
            || item.version != 1
        {
            return Err(invalid(
                "context pin differs from the admitted Skill contract",
            ));
        }
        let config: serde_json::Value = serde_json::from_str(&item.config_json)?;
        if config.get("reference").and_then(serde_json::Value::as_str)
            != Some(pin.reference.as_str())
            || pin.version.len() > 256
            || pin.version.chars().any(char::is_control)
            || !valid_digest(&pin.digest)
        {
            return Err(invalid(
                "context pin has an invalid reference, version, or digest",
            ));
        }
        if config
            .get("version")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|v| v != pin.version)
        {
            return Err(StoreError::Conflict(
                "resolved Skill version differs from accepted policy".into(),
            ));
        }
        if config
            .get("digest")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|v| v.trim().to_lowercase() != pin.digest)
        {
            return Err(StoreError::Conflict(
                "resolved Skill digest differs from accepted policy".into(),
            ));
        }
        let value = (&pin.version, &pin.digest);
        if references
            .insert(&pin.reference, value)
            .is_some_and(|previous| previous != value)
        {
            return Err(invalid(
                "one Skill reference resolved to conflicting packages",
            ));
        }
    }
    for omission in &manifest.omissions {
        let key = (omission.set_id.as_str(), omission.item_id.as_str());
        let item = items
            .get(&key)
            .ok_or_else(|| invalid("context omission names an unadmitted Context Item"))?;
        if !seen.insert(key)
            || item.required
            || item.item_key != omission.item_key
            || item.r#type != omission.r#type
            || item.version != omission.version
            || !matches!(
                omission.reason.as_str(),
                "No supported Context Resolver is configured"
                    | "Harness does not support Skill inputs"
            )
        {
            return Err(invalid(
                "context omission differs from an optional admitted contract",
            ));
        }
    }
    Ok(())
}
fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
