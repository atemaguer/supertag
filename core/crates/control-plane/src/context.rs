//! Durable resolution of admitted context, separate from immutable catalog policy.
use crate::AttemptAccess;
use crate::{
    Store, StoreError,
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
        authority: &crate::AttemptAccess,
    ) -> Result<ContextResolutionManifest> {
        let (host, attempt) = (authority.host(), authority.lease());
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
        authority: &AttemptAccess,
        input: &CommitContextResolutionRequest,
    ) -> Result<ContextResolutionManifest> {
        let host = authority.host();
        let attempt = authority.lease();
        let mut manifest = input
            .manifest
            .clone()
            .ok_or_else(|| invalid("context resolution requires a manifest"))?;
        if manifest.encoded_len() > 128 * 1024 {
            return Err(invalid("context resolution manifest exceeds size limit"));
        }
        manifest.pins.sort_by(|a, b| {
            (&a.set_id, &a.item_id, &a.reference).cmp(&(&b.set_id, &b.item_id, &b.reference))
        });
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
/// The `reference` of a Skill Context Item that loads every Skill available to the Task.
pub(crate) const WILDCARD: &str = "*";
/// The omission a `*` item records when its Task has no Skill to load.
const NO_SKILLS: &str = "No Skills are available to this Task";
const MAX_SKIPPED: usize = 128;

/// Whether a Skill Context Item's configuration names every available Skill.
pub(crate) fn is_wildcard(config: &serde_json::Value) -> bool {
    config.get("reference").and_then(serde_json::Value::as_str) == Some(WILDCARD)
}

fn bounded(value: &str) -> bool {
    value.chars().count() <= 256 && !value.chars().any(char::is_control)
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
    // A named item resolves to one pin or omission; a `*` item to a pin for each Skill it loaded,
    // or to one omission.
    let mut pinned: BTreeMap<(&str, &str), BTreeSet<&str>> = BTreeMap::new();
    let mut references = BTreeMap::new();
    for pin in &manifest.pins {
        let key = (pin.set_id.as_str(), pin.item_id.as_str());
        let item = items
            .get(&key)
            .ok_or_else(|| invalid("context pin names an unadmitted Context Item"))?;
        let config: serde_json::Value = serde_json::from_str(&item.config_json)?;
        let wildcard = is_wildcard(&config);
        let loaded = pinned.entry(key).or_default();
        if !loaded.insert(pin.reference.as_str())
            || (!wildcard && loaded.len() > 1)
            || item.item_key != pin.item_key
            || item.r#type != "supertag/skill"
            || item.version != 1
        {
            return Err(invalid(
                "context pin differs from the admitted Skill contract",
            ));
        }
        let reference_matches = if wildcard {
            !pin.reference.is_empty() && pin.reference != WILDCARD && bounded(&pin.reference)
        } else {
            config.get("reference").and_then(serde_json::Value::as_str)
                == Some(pin.reference.as_str())
        };
        if !reference_matches
            || pin.version.len() > 256
            || pin.version.chars().any(char::is_control)
            || !bounded(&pin.source)
            || !valid_digest(&pin.digest)
        {
            return Err(invalid(
                "context pin has an invalid reference, version, source, or digest",
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
        let value = (&pin.version, &pin.digest, &pin.source);
        if references
            .insert(&pin.reference, value)
            .is_some_and(|previous| previous != value)
        {
            return Err(invalid(
                "one Skill reference resolved to conflicting packages",
            ));
        }
    }
    let mut omitted = BTreeSet::new();
    for omission in &manifest.omissions {
        let key = (omission.set_id.as_str(), omission.item_id.as_str());
        let item = items
            .get(&key)
            .ok_or_else(|| invalid("context omission names an unadmitted Context Item"))?;
        let wildcard = item.r#type == "supertag/skill"
            && serde_json::from_str::<serde_json::Value>(&item.config_json)
                .is_ok_and(|config| is_wildcard(&config));
        let reason = match omission.reason.as_str() {
            "No supported Context Resolver is configured"
            | "Harness does not support Skill inputs" => true,
            NO_SKILLS => wildcard,
            _ => false,
        };
        if !omitted.insert(key)
            || pinned.contains_key(&key)
            || item.required
            || item.item_key != omission.item_key
            || item.r#type != omission.r#type
            || item.version != omission.version
            || !reason
        {
            return Err(invalid(
                "context omission differs from an optional admitted contract",
            ));
        }
    }
    if pinned.len() + omitted.len() != items.len() {
        return Err(invalid(
            "context resolution must cover every admitted Context Item exactly once",
        ));
    }
    if manifest.skipped.len() > MAX_SKIPPED
        || manifest.skipped.iter().any(|skipped| {
            skipped.reference.is_empty()
                || !bounded(&skipped.reference)
                || !bounded(&skipped.source)
                || !bounded(&skipped.reason)
        })
    {
        return Err(invalid("context resolution records invalid skipped Skills"));
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
