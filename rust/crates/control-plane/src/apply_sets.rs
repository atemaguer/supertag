//! Apply-set membership and pruning for declarative manifests.
//!
//! A resource joins an apply set only when that set's apply created it. The
//! membership records the revision the set last left it at. Pruning removes a
//! member the set's input no longer declares only while it is still at that
//! revision: a member another writer changed since is released instead, and
//! a member still in use is kept for a later prune. Reconciliation and every
//! removal happen in one serialized write, so a prune is all or nothing.
use std::collections::BTreeMap;

use sqlx::{Any, Row, Transaction};
use supertag_protocol::v2::*;

use crate::{
    Store, StoreError,
    policy::operator,
    store::{Result, invalid, name},
};

/// Prunable kinds, in removal order: dependents before what they use.
const KINDS: [&str; 8] = [
    "SurfaceLocation",
    "Team",
    "Tag",
    "Role",
    "PermissionSet",
    "ContextSet",
    "Workspace",
    "Volume",
];
const MAX_DECLARED: usize = 1024;

/// Removes a resource's apply-set membership when it is deleted or retired, so
/// a later resource with the same name is never mistaken for a member.
pub(crate) async fn forget(tx: &mut Transaction<'_, Any>, kind: &str, name: &str) -> Result<()> {
    sqlx::query("DELETE FROM supertag_v2_apply_set_members WHERE kind=$1 AND name=$2")
        .bind(kind)
        .bind(name)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn order(kind: &str) -> Result<usize> {
    KINDS
        .iter()
        .position(|value| *value == kind)
        .ok_or_else(|| invalid("unsupported apply set kind"))
}

async fn revision(tx: &mut Transaction<'_, Any>, kind: &str, id: &str) -> Result<Option<u64>> {
    match kind {
        "SurfaceLocation" => crate::surface_policy::catalog::location_revision_in(tx, id).await,
        "Team" => {
            let revision: Option<i64> =
                sqlx::query_scalar("SELECT revision FROM supertag_v2_teams WHERE team_id=$1")
                    .bind(id)
                    .fetch_optional(&mut **tx)
                    .await?;
            Ok(revision.map(|value| value as u64))
        }
        "Tag" => crate::tags::active_revision_in(tx, id).await,
        "Role" | "PermissionSet" | "ContextSet" => {
            crate::policy::policy_revision_in(tx, kind, id).await
        }
        "Workspace" => crate::github_workspaces::revision_in(tx, id).await,
        "Volume" => crate::artifact_volumes::revision_in(tx, id).await,
        _ => Err(invalid("unsupported apply set kind")),
    }
}

async fn remove(
    tx: &mut Transaction<'_, Any>,
    kind: &str,
    id: &str,
    expected: u64,
    now_ms: i64,
) -> Result<()> {
    match kind {
        "SurfaceLocation" => {
            crate::surface_policy::catalog::delete_location_in(tx, id, expected).await
        }
        "Team" => {
            let team = crate::teams::team_by_reference_in(tx, id).await?;
            if team.team_id != id {
                return Err(StoreError::Conflict("Team identity changed".into()));
            }
            crate::teams::delete_team_in(tx, &team, Some(expected)).await
        }
        "Tag" => crate::tags::retire_in(tx, id, expected, now_ms).await,
        "Role" => crate::policy::retire_role_in(tx, id, expected).await,
        "PermissionSet" => crate::policy::delete_permission_set_in(tx, id, expected).await,
        "ContextSet" => crate::policy::delete_context_set_in(tx, id, expected).await,
        "Workspace" => crate::github_workspaces::delete_in(tx, id, expected).await,
        "Volume" => crate::artifact_volumes::delete_in(tx, id, expected).await,
        _ => Err(invalid("unsupported apply set kind")),
    }
}

/// The apply set a resource belongs to, if any.
async fn owner(tx: &mut Transaction<'_, Any>, kind: &str, id: &str) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT apply_set FROM supertag_v2_apply_set_members WHERE kind=$1 AND name=$2",
    )
    .bind(kind)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?)
}

async fn record(
    tx: &mut Transaction<'_, Any>,
    apply_set: &str,
    kind: &str,
    id: &str,
    revision: u64,
) -> Result<()> {
    let revision = i64::try_from(revision).map_err(|_| invalid("revision is out of range"))?;
    sqlx::query("INSERT INTO supertag_v2_apply_set_members (kind,name,apply_set,observed_revision) VALUES ($1,$2,$3,$4) ON CONFLICT(kind,name) DO UPDATE SET apply_set=excluded.apply_set,observed_revision=excluded.observed_revision")
        .bind(kind)
        .bind(id)
        .bind(apply_set)
        .bind(revision)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

impl Store {
    pub async fn reconcile_apply_set(
        &self,
        principal: &str,
        input: &ReconcileApplySetRequest,
    ) -> Result<ReconcileApplySetResponse> {
        operator(principal)?;
        if input.apply_set.is_empty() {
            return Err(invalid("an apply set name is required"));
        }
        let apply_set = crate::manifest_relationships::manager(&input.apply_set)?;
        if input.declared.len() > MAX_DECLARED {
            return Err(invalid("too many apply set declarations"));
        }
        let mut declared = BTreeMap::new();
        for item in &input.declared {
            order(&item.kind)?;
            name("apply set member name", &item.name)?;
            if declared
                .insert((item.kind.as_str(), item.name.as_str()), item)
                .is_some()
            {
                return Err(invalid("duplicate apply set declaration"));
            }
        }
        let (mut tx, _) = self.write().await?;
        let now_ms = self.execution_now_ms();
        for ((kind, id), item) in &declared {
            let Some(current) = revision(&mut tx, kind, id).await? else {
                // A preview declares resources the apply has not created yet.
                continue;
            };
            let stored = owner(&mut tx, kind, id).await?;
            let mine = stored.as_deref() == Some(apply_set);
            if current != item.revision {
                // Another writer changed it after this apply left it.
                if mine {
                    forget(&mut tx, kind, id).await?;
                }
            } else if mine || (stored.is_none() && item.created) {
                record(&mut tx, apply_set, kind, id, current).await?;
            } else if stored.is_some() {
                // Two apply sets declare it; neither may prune it.
                forget(&mut tx, kind, id).await?;
            }
        }
        let mut pruned = Vec::new();
        if input.prune {
            let rows = sqlx::query(
                "SELECT kind,name,observed_revision FROM supertag_v2_apply_set_members WHERE apply_set=$1",
            )
            .bind(apply_set)
            .fetch_all(&mut *tx)
            .await?;
            let mut members = Vec::new();
            for row in rows {
                let kind: String = row.try_get("kind")?;
                let id: String = row.try_get("name")?;
                if declared.contains_key(&(kind.as_str(), id.as_str())) {
                    continue;
                }
                let observed = row.try_get::<i64, _>("observed_revision")? as u64;
                members.push((order(&kind)?, kind, id, observed));
            }
            members.sort();
            for (_, kind, id, observed) in members {
                let (action, reason) = match revision(&mut tx, &kind, &id).await? {
                    None => {
                        forget(&mut tx, &kind, &id).await?;
                        (ApplySetPruneAction::Forget, String::new())
                    }
                    Some(current) if current != observed => {
                        forget(&mut tx, &kind, &id).await?;
                        (
                            ApplySetPruneAction::Release,
                            format!("changed outside apply set {apply_set} after it was applied"),
                        )
                    }
                    Some(current) => match remove(&mut tx, &kind, &id, current, now_ms).await {
                        Ok(()) => (ApplySetPruneAction::Delete, String::new()),
                        Err(StoreError::FailedPrecondition(reason)) => {
                            (ApplySetPruneAction::Keep, reason)
                        }
                        Err(error) => return Err(error),
                    },
                };
                pruned.push(ApplySetPrune {
                    kind,
                    name: id,
                    action: action.into(),
                    reason,
                });
            }
        }
        if input.preview {
            tx.rollback().await?;
        } else {
            tx.commit().await?;
        }
        Ok(ReconcileApplySetResponse { pruned })
    }
}
