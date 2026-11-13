use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    ObjectiveStatus, PermissionSet, RetireTagResponse, RoleAssignmentStatus, Tag, TaskState,
};
use tokio_stream::StreamExt;

use crate::{
    Store, StoreError,
    store::{Result, invalid, name},
};

pub(crate) fn validate_display_name(value: &str) -> Result<()> {
    name("Tag name", value)?;
    if value.trim() != value {
        return Err(invalid("Tag name must not start or end with whitespace"));
    }
    Ok(())
}

pub(crate) fn ensure_active(row: &AnyRow, tag_id: &str) -> Result<()> {
    if row.try_get::<Option<i64>, _>("retired_at_ms")?.is_some() {
        return Err(StoreError::FailedPrecondition(format!(
            "Tag {tag_id} is retired"
        )));
    }
    Ok(())
}

pub(crate) async fn require_active(tx: &mut Transaction<'_, Any>, tag_id: &str) -> Result<()> {
    let row = sqlx::query("SELECT retired_at_ms FROM supertag_v2_tags WHERE tag_id=$1")
        .bind(tag_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| missing(tag_id))?;
    ensure_active(&row, tag_id)
}

pub(crate) async fn active_name_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    requested: Option<&str>,
) -> Result<String> {
    let row = sqlx::query("SELECT name,retired_at_ms FROM supertag_v2_tags WHERE tag_id=$1")
        .bind(tag_id)
        .fetch_optional(&mut **tx)
        .await?;
    let prior = if let Some(row) = row {
        ensure_active(&row, tag_id)?;
        row.try_get::<Option<String>, _>("name")?
    } else {
        None
    };
    let selected = requested.or(prior.as_deref()).unwrap_or(tag_id);
    let occupied: Option<String> = sqlx::query_scalar(
        "SELECT tag_id FROM supertag_v2_tags
         WHERE retired_at_ms IS NULL AND COALESCE(name,tag_id)=$1 AND tag_id<>$2",
    )
    .bind(selected)
    .bind(tag_id)
    .fetch_optional(&mut **tx)
    .await?;
    if occupied.is_some() {
        return Err(StoreError::Conflict(format!(
            "Tag name {selected} is already in use"
        )));
    }
    Ok(selected.into())
}

pub(crate) fn tag_from_row(row: &AnyRow) -> Result<Tag> {
    let tag_id: String = row.try_get("tag_id")?;
    Ok(Tag {
        name: row
            .try_get::<Option<String>, _>("name")?
            .unwrap_or_else(|| tag_id.clone()),
        tag_id,
        instructions: row.try_get("instructions")?,
        allowed_actions: serde_json::from_str(&row.try_get::<String, _>("allowed_actions")?)?,
        revision: row.try_get::<i64, _>("revision")? as u64,
        workspace: crate::workspaces::workspace_from_row(row)?,
        harness_kind: row.try_get::<i64, _>("harness_kind")? as i32,
        approval_rules: crate::store::approval_rules_from_row(row)?,
        execution: crate::store::tag_execution_from_row(row)?,
        retired_at_ms: row.try_get("retired_at_ms")?,
        runs_on: serde_json::from_str(&row.try_get::<String, _>("runs_on")?)?,
    })
}

fn missing(tag_id: &str) -> StoreError {
    StoreError::NotFound(format!("Tag {tag_id} was not found"))
}

impl Store {
    pub async fn get_tag(&self, tag_id: &str) -> Result<Tag> {
        name("Tag ID", tag_id)?;
        let row = sqlx::query("SELECT * FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| missing(tag_id))?;
        tag_from_row(&row)
    }

    pub async fn retire_tag(&self, tag_id: &str, dry_run: bool) -> Result<RetireTagResponse> {
        name("Tag ID", tag_id)?;
        let (mut tx, _) = self.write().await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| missing(tag_id))?;
        let mut response = RetireTagResponse {
            tag: Some(tag_from_row(&row)?),
            ..Default::default()
        };
        if response
            .tag
            .as_ref()
            .is_some_and(|tag| tag.retired_at_ms.is_some())
        {
            tx.rollback().await?;
            return Ok(response);
        }

        response.blockers = blockers(&mut tx, tag_id).await?;
        if !dry_run && !response.blockers.is_empty() {
            return Err(StoreError::FailedPrecondition(format!(
                "Tag {tag_id} is in use by {}",
                response.blockers.join(", ")
            )));
        }
        let counts = sqlx::query(
            "SELECT
             (SELECT COUNT(*) FROM supertag_v2_surface_locations l
               JOIN supertag_v2_managed_connector_aliases a USING (connector_account_id)
               WHERE a.tag_id=$1) AS locations,
             (SELECT COUNT(*) FROM supertag_v2_host_tags WHERE tag_id=$1) AS hosts,
             (SELECT COUNT(*) FROM supertag_v2_mailbox_grants
               WHERE sender_tag_id=$1 OR recipient_tag_id=$1) AS grants,
             (SELECT COUNT(*) FROM supertag_v2_role_assignments
               WHERE tag_id=$1 AND status=$2) AS roles",
        )
        .bind(tag_id)
        .bind(RoleAssignmentStatus::Active as i64)
        .fetch_one(&mut *tx)
        .await?;
        response.surface_locations = counts.try_get::<i64, _>("locations")? as u64;
        response.host_bindings = counts.try_get::<i64, _>("hosts")? as u64;
        response.mailbox_grants = counts.try_get::<i64, _>("grants")? as u64;
        response.role_assignments = counts.try_get::<i64, _>("roles")? as u64;
        if dry_run {
            tx.rollback().await?;
            return Ok(response);
        }
        let row = retire_unused_in(&mut tx, tag_id, self.execution_now_ms()).await?;
        response.tag = Some(tag_from_row(&row)?);
        tx.commit().await?;
        Ok(response)
    }
}

/// Retires an unused Tag after its blockers were checked, removing what binds it.
async fn retire_unused_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    now_ms: i64,
) -> Result<AnyRow> {
    // Alias ownership and exact ingress receipts remain available for replay.
    sqlx::query(
        "DELETE FROM supertag_v2_surface_locations WHERE connector_account_id IN
         (SELECT connector_account_id FROM supertag_v2_managed_connector_aliases WHERE tag_id=$1)",
    )
    .bind(tag_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query("DELETE FROM supertag_v2_host_tags WHERE tag_id=$1")
        .bind(tag_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "DELETE FROM supertag_v2_mailbox_grants WHERE sender_tag_id=$1 OR recipient_tag_id=$1",
    )
    .bind(tag_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE supertag_v2_role_assignments SET status=$1,revision=revision+1
         WHERE tag_id=$2 AND status=$3",
    )
    .bind(RoleAssignmentStatus::Inactive as i64)
    .bind(tag_id)
    .bind(RoleAssignmentStatus::Active as i64)
    .execute(&mut **tx)
    .await?;
    let row = sqlx::query(
        "UPDATE supertag_v2_tags SET retired_at_ms=$1,revision=revision+1
         WHERE tag_id=$2 RETURNING *",
    )
    .bind(now_ms)
    .bind(tag_id)
    .fetch_one(&mut **tx)
    .await?;
    crate::apply_sets::forget(tx, "Tag", tag_id).await?;
    Ok(row)
}

/// The revision of an active Tag; a retired or missing Tag has none.
pub(crate) async fn active_revision_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
) -> Result<Option<u64>> {
    let revision: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM supertag_v2_tags WHERE tag_id=$1 AND retired_at_ms IS NULL",
    )
    .bind(tag_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(revision.map(|value| value as u64))
}

/// Retires an active, unused Tag at `expected_revision`, as `retire_tag` does.
pub(crate) async fn retire_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    expected_revision: u64,
    now_ms: i64,
) -> Result<()> {
    if active_revision_in(tx, tag_id).await? != Some(expected_revision) {
        return Err(StoreError::Conflict("Tag revision changed".into()));
    }
    let mut blockers = blockers(tx, tag_id).await?;
    // Pruning never removes a Surface location the apply set did not remove itself.
    let location: Option<String> = sqlx::query_scalar(
        "SELECT l.location_id FROM supertag_v2_surface_locations l
         JOIN supertag_v2_managed_connector_aliases a USING (connector_account_id)
         WHERE a.tag_id=$1 ORDER BY l.location_id LIMIT 1",
    )
    .bind(tag_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(location) = location {
        blockers.push(format!("Surface location {location}"));
    }
    if !blockers.is_empty() {
        return Err(StoreError::FailedPrecondition(format!(
            "Tag {tag_id} is in use by {}",
            blockers.join(", ")
        )));
    }
    retire_unused_in(tx, tag_id, now_ms).await?;
    Ok(())
}

async fn blockers(tx: &mut Transaction<'_, Any>, tag_id: &str) -> Result<Vec<String>> {
    // Bound the response even when a Tag is used by a large organization.
    let mut reasons = sqlx::query_scalar(
        "SELECT reason FROM (
           SELECT 'open Task ' || t.task_id AS reason
           FROM supertag_v2_tasks t
           WHERE (t.state IN ($2,$3,$4,$5) OR t.cleanup_pending<>0) AND
             (t.tag_id=$1 OR EXISTS (SELECT 1 FROM supertag_v2_work_sessions w
              WHERE w.latest_task_id=t.task_id AND w.parent_tag_id=$1))
           UNION ALL
           SELECT 'Objective ' || objective_id || ' (owner)'
           FROM supertag_v2_objectives WHERE owner_tag_id=$1 AND status NOT IN ($6,$7)
           UNION ALL
           SELECT 'Team ' || team_id || ' (member)' FROM supertag_v2_team_members WHERE tag_id=$1
         ) refs ORDER BY reason LIMIT 10",
    )
    .bind(tag_id)
    .bind(TaskState::Queued as i64)
    .bind(TaskState::Claimed as i64)
    .bind(TaskState::Running as i64)
    .bind(TaskState::Uncertain as i64)
    .bind(ObjectiveStatus::Completed as i64)
    .bind(ObjectiveStatus::Cancelled as i64)
    .fetch_all(&mut **tx)
    .await?;
    if reasons.len() < 10 {
        let approver = format!("tag:{tag_id}");
        let mut sets = sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT payload FROM supertag_v2_permission_sets ORDER BY set_id",
        )
        .fetch(&mut **tx);
        while let Some(payload) = sets.next().await {
            let set: PermissionSet = crate::policy::decode(&payload?)?;
            if set.approvers.contains(&approver) {
                reasons.push(format!("Permission Set {} (approver)", set.name));
                if reasons.len() == 10 {
                    break;
                }
            }
        }
    }
    Ok(reasons)
}
