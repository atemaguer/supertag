//! Pin a remote Workspace's branch to one commit per Session, before its Tasks are claimable.
//! Git delivery reads the branch; every Task of the Session starts from the pinned commit.
use crate::{
    Store, StoreError, policy,
    store::{Result, invalid},
};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use uuid::Uuid;

/// The internal principal of git delivery.
pub(crate) const DELIVERY: &str = "delivery:git";

pub(crate) fn delivery(principal: &str) -> Result<()> {
    if principal == DELIVERY {
        Ok(())
    } else {
        Err(StoreError::PermissionDenied)
    }
}

fn decode(row: &AnyRow) -> Result<WorkspaceSourcePin> {
    Ok(WorkspaceSourcePin {
        pin_id: row.try_get("pin_id")?,
        tag_id: row.try_get("tag_id")?,
        session_id: row.try_get("session_id")?,
        selector: Some(policy::decode(&row.try_get::<Vec<u8>, _>("selector")?)?),
        selector_digest: row.try_get("selector_digest")?,
        resolved: row
            .try_get::<Option<Vec<u8>>, _>("resolved")?
            .as_deref()
            .map(policy::decode)
            .transpose()?,
        created_order: row.try_get::<i64, _>("created_order")? as u64,
    })
}

fn digest(value: &Workspace) -> String {
    format!("{:x}", Sha256::digest(value.encode_to_vec()))
}

/// The catalog settings a Session pinned, without the pin itself.
fn selector(value: &Workspace) -> Workspace {
    Workspace {
        commit: String::new(),
        resolved_ref: String::new(),
        ..value.clone()
    }
}

/// A child of the same Session keeps its parent's pin when the catalog settings still match.
pub(crate) fn inherit(workspace: &mut Option<WorkspaceSpec>, prior: &Option<WorkspaceSpec>) {
    if let (Some(current), Some(prior)) = (workspace, prior)
        && current.workspace_id == prior.workspace_id
        && let (Some(selected), Some(pinned)) = (&current.remote, &prior.remote)
        && selector(selected) == selector(pinned)
    {
        current.remote = prior.remote.clone();
        current.base_commit = prior.base_commit.clone();
    }
}

/// Applies the Session's pin, or records a pending one. A Session pin never consults a mutable
/// catalog during resolution or replay.
pub(crate) async fn bind_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    session: &str,
    workspace: &mut Option<WorkspaceSpec>,
) -> Result<()> {
    let Some(spec) = workspace else { return Ok(()) };
    let Some(value) = &spec.remote else {
        return Ok(());
    };
    if !value.commit.is_empty() {
        return Ok(());
    }
    let existing = sqlx::query(
        "SELECT * FROM supertag_v2_workspace_source_pins WHERE tag_id=$1 AND session_id=$2",
    )
    .bind(tag)
    .bind(session)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(row) = existing {
        let pin = decode(&row)?;
        if pin.selector.as_ref().map(selector) != Some(selector(value)) {
            return Err(StoreError::FailedPrecondition(
                "the Workspace changed since this Session started; start a new Session".into(),
            ));
        }
        if let Some(resolved) = pin.resolved {
            spec.base_commit = resolved.commit.clone();
            spec.remote = Some(resolved);
        }
    } else {
        let order = crate::store::next_order(tx).await?;
        sqlx::query("INSERT INTO supertag_v2_workspace_source_pins(pin_id,tag_id,session_id,selector,selector_digest,created_order) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(Uuid::new_v4().to_string()).bind(tag).bind(session).bind(value.encode_to_vec()).bind(digest(value)).bind(order).execute(&mut **tx).await?;
    }
    Ok(())
}

impl Store {
    pub async fn list_pending_workspace_sources(
        &self,
        principal: &str,
        input: &ListPendingWorkspaceSourcesRequest,
    ) -> Result<ListPendingWorkspaceSourcesResponse> {
        delivery(principal)?;
        let after = i64::try_from(input.after_order)
            .map_err(|_| invalid("source cursor is outside its range"))?;
        let limit = if input.limit == 0 {
            50
        } else {
            input.limit.min(100)
        } as usize;
        let rows=sqlx::query("SELECT pin.* FROM supertag_v2_workspace_source_pins pin WHERE resolved IS NULL AND created_order>$1 AND EXISTS(SELECT 1 FROM supertag_v2_tasks t WHERE t.tag_id=pin.tag_id AND t.session_id=pin.session_id AND t.state=$2) ORDER BY created_order LIMIT $3")
            .bind(after).bind(TaskState::Queued as i64).bind((limit+1) as i64).fetch_all(&self.pool).await?;
        let mut pins = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for row in rows {
            let pin = decode(&row)?;
            bytes += pin.encoded_len() + 16;
            if pins.len() == limit || bytes > MAX_MESSAGE_BYTES - 4096 {
                more = true;
                break;
            }
            pins.push(pin);
        }
        let next_after_order = if more {
            pins.last().map_or(0, |pin| pin.created_order)
        } else {
            0
        };
        Ok(ListPendingWorkspaceSourcesResponse {
            pins,
            next_after_order,
        })
    }

    /// Pins a Session's source. With `error`, the Session's queued Tasks fail with it instead and
    /// the pin is forgotten, so the Session's next message tries again.
    pub async fn pin_workspace_source(
        &self,
        principal: &str,
        input: &PinWorkspaceSourceRequest,
    ) -> Result<WorkspaceSourcePin> {
        delivery(principal)?;
        let (mut tx, _) = self.write().await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_workspace_source_pins WHERE pin_id=$1")
            .bind(&input.pin_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| StoreError::NotFound("Workspace source pin was not found".into()))?;
        let mut pin = decode(&row)?;
        if pin.selector_digest != input.selector_digest {
            return Err(StoreError::Conflict(
                "Workspace source selector changed".into(),
            ));
        }
        // A delayed or competing lookup may observe a new remote head. The committed Session pin
        // wins; it is never silently moved on replay.
        if pin.resolved.is_some() {
            return Ok(pin);
        }
        let selector = pin
            .selector
            .clone()
            .ok_or_else(|| invalid("Workspace source selector is missing"))?;
        if !input.error.is_empty() {
            let reason: String = format!(
                "The Workspace {} could not be read: {}",
                selector.workspace_id,
                input.error.chars().take(1000).collect::<String>()
            );
            sqlx::query("UPDATE supertag_v2_tasks SET state=$1,result=$2,completed_at_ms=$3 WHERE tag_id=$4 AND session_id=$5 AND workspace_remote=$6 AND state=$7")
                .bind(TaskState::Failed as i64).bind(&reason).bind(self.execution_now_ms()).bind(&pin.tag_id).bind(&pin.session_id).bind(selector.encode_to_vec()).bind(TaskState::Queued as i64).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM supertag_v2_workspace_source_pins WHERE pin_id=$1")
                .bind(&pin.pin_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(pin);
        }
        if !supertag_protocol::valid_git_commit(&input.commit) {
            return Err(invalid("full Git source commit required"));
        }
        if !supertag_protocol::valid_git_branch(&input.resolved_ref)
            || (!selector.r#ref.is_empty() && selector.r#ref != input.resolved_ref)
        {
            return Err(StoreError::Conflict(
                "Workspace source resolution changed the requested branch".into(),
            ));
        }
        let mut resolved = selector.clone();
        resolved.commit = input.commit.clone();
        resolved.resolved_ref = input.resolved_ref.clone();
        sqlx::query("UPDATE supertag_v2_tasks SET workspace_base_commit=$1,workspace_remote=$2 WHERE tag_id=$3 AND session_id=$4 AND workspace_remote=$5 AND state=$6")
            .bind(&input.commit).bind(resolved.encode_to_vec()).bind(&pin.tag_id).bind(&pin.session_id).bind(selector.encode_to_vec()).bind(TaskState::Queued as i64).execute(&mut *tx).await?;
        sqlx::query("UPDATE supertag_v2_workspace_source_pins SET resolved=$1 WHERE pin_id=$2")
            .bind(resolved.encode_to_vec())
            .bind(&pin.pin_id)
            .execute(&mut *tx)
            .await?;
        pin.resolved = Some(resolved);
        tx.commit().await?;
        Ok(pin)
    }
}
