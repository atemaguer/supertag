use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{v2::*, validate_workspace_delivery};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store, StoreError,
    store::{HostAuthority, Result, invalid, lease_is_live, name, owned},
};

impl Store {
    /// Records the commit the running Attempt's Worker Host resolved for its Task's Workspace
    /// branch. The first resolution in a Session wins: it is recorded on every unresolved Task of
    /// the Session that follows the same branch, and a later or repeated report returns the
    /// recorded commit unchanged.
    pub async fn resolve_workspace_ref(
        &self,
        host: &HostAuthority,
        input: &ResolveWorkspaceRefRequest,
    ) -> Result<Task> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Task Attempt is required"))?;
        if !supertag_protocol::valid_git_commit(&input.base_commit) {
            return Err(invalid("full Git base commit required"));
        }
        let (mut tx, _) = self.write().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        require_running(&task, self.execution_now_ms())?;
        let spec = workspace_from_row(&task)?.ok_or_else(|| invalid("Attempt has no workspace"))?;
        if spec.base_ref.is_empty() {
            return Err(StoreError::FailedPrecondition(
                "Task Workspace does not follow a branch".into(),
            ));
        }
        if spec.base_commit.is_empty() {
            sqlx::query(
                "UPDATE supertag_v2_tasks SET workspace_base_commit=$1
                 WHERE tag_id=$2 AND session_id=$3 AND workspace_id=$4 AND workspace_base_ref=$5
                   AND workspace_base_commit='' AND state IN ($6,$7,$8)",
            )
            .bind(&input.base_commit)
            .bind(task.try_get::<String, _>("tag_id")?)
            .bind(task.try_get::<String, _>("session_id")?)
            .bind(&spec.workspace_id)
            .bind(&spec.base_ref)
            // A Task that ended unresolved never started from any commit, so it stays unresolved.
            .bind(TaskState::Queued as i64)
            .bind(TaskState::Claimed as i64)
            .bind(TaskState::Running as i64)
            .execute(&mut *tx)
            .await?;
        }
        let mut task = crate::store::task_in(&mut tx, &attempt.task_id).await?;
        // The host commits from this copy, so it carries the Tag's authorship like every other.
        crate::workspace_landings::with_author_in(&mut tx, &mut task).await?;
        tx.commit().await?;
        Ok(task)
    }

    pub async fn get_workspace_continuation(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
    ) -> Result<Option<WorkspaceDeliveryReference>> {
        let mut tx = self.pool.begin().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        require_running(&task, self.execution_now_ms())?;
        workspace_from_row(&task)?.ok_or_else(|| invalid("Attempt has no workspace"))?;
        let delivery = continuation_in(&mut tx, &task).await?;
        tx.commit().await?;
        Ok(delivery)
    }

    /// The running Attempt waits for the Worker Host holding its Session's last delivery, which is
    /// not connected, or no longer waits. The Task then names that host, taken from the delivery,
    /// so `describe task`, `placement explain` and its conversation say what it waits for.
    pub async fn report_waiting_for_holder(
        &self,
        host: &HostAuthority,
        input: &ReportWaitingForHolderRequest,
    ) -> Result<Task> {
        let _wake = self.wake_follows();
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt is required"))?;
        let (mut tx, _) = self.write().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        require_running(&task, self.execution_now_ms())?;
        let holder = if input.waiting {
            let delivery = continuation_in(&mut tx, &task)
                .await?
                .ok_or_else(|| invalid("Attempt has no Session continuation to wait for"))?;
            Some(delivery_holder_in(&mut tx, &delivery).await?.host_id)
        } else {
            None
        };
        sqlx::query("UPDATE supertag_v2_tasks SET waiting_holder=$1 WHERE task_id=$2")
            .bind(&holder)
            .bind(&attempt.task_id)
            .execute(&mut *tx)
            .await?;
        let task = crate::store::task_in(&mut tx, &attempt.task_id).await?;
        tx.commit().await?;
        Ok(task)
    }

    pub async fn reserve_workspace_delivery(
        &self,
        host: &HostAuthority,
        input: &WorkspaceDeliveryRequest,
    ) -> Result<WorkspaceDeliveryReference> {
        self.record_workspace_delivery(host, input, false).await
    }

    pub async fn commit_workspace_delivery(
        &self,
        host: &HostAuthority,
        input: &WorkspaceDeliveryRequest,
    ) -> Result<WorkspaceDeliveryReference> {
        self.record_workspace_delivery(host, input, true).await
    }

    async fn record_workspace_delivery(
        &self,
        host: &HostAuthority,
        input: &WorkspaceDeliveryRequest,
        commit: bool,
    ) -> Result<WorkspaceDeliveryReference> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity required"))?;
        let reference = input
            .delivery
            .as_ref()
            .ok_or_else(|| invalid("workspace delivery required"))?;
        validate_workspace_delivery(reference).map_err(|error| invalid(error.message()))?;
        let delivery_id = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &attempt.task_id,
                &attempt.attempt_id
            ))?)
        );
        if reference.delivery_id != delivery_id {
            return Err(invalid("workspace delivery does not identify this Attempt"));
        }

        let (mut tx, _) = self.write().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let prior = sqlx::query("SELECT reference,committed_at_ms FROM supertag_v2_workspace_deliveries WHERE attempt_id=$1 AND task_id=$2")
            .bind(&attempt.attempt_id).bind(&attempt.task_id).fetch_optional(&mut *tx).await?;
        let now = self.execution_now_ms();
        if let Some(prior) = prior {
            if &decode_delivery(prior.try_get("reference")?)? != reference {
                return Err(StoreError::Conflict(
                    "Attempt already reserved a different workspace delivery".into(),
                ));
            }
            if commit
                && prior
                    .try_get::<Option<i64>, _>("committed_at_ms")?
                    .is_none()
            {
                require_running(&task, now)?;
                sqlx::query("UPDATE supertag_v2_workspace_deliveries SET committed_at_ms=$1 WHERE attempt_id=$2")
                    .bind(now).bind(&attempt.attempt_id).execute(&mut *tx).await?;
            } else if !commit {
                require_running(&task, now)?;
            }
        } else {
            require_running(&task, now)?;
            if commit {
                return Err(StoreError::FailedPrecondition(
                    "workspace delivery must be reserved first".into(),
                ));
            }
            let spec =
                workspace_from_row(&task)?.ok_or_else(|| invalid("Attempt has no workspace"))?;
            let previous = continuation_in(&mut tx, &task).await?;
            let start = previous
                .as_ref()
                .map_or(&spec.base_commit, |value| &value.head_commit);
            if reference.workspace_id != spec.workspace_id
                || reference.base_commit != spec.base_commit
                || &reference.start_commit != start
            {
                return Err(StoreError::FailedPrecondition(
                    "workspace delivery does not match the accepted pins".into(),
                ));
            }
            // The reporting host holds the patch and bundle; the Control Plane stores neither.
            sqlx::query("INSERT INTO supertag_v2_workspace_deliveries (attempt_id,task_id,reference,holder_host_id) VALUES ($1,$2,$3,$4)")
                .bind(&attempt.attempt_id).bind(&attempt.task_id).bind(reference.encode_to_vec()).bind(host.id()).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(reference.clone())
    }

    /// The latest accepted delivery of the one Session the principal may read with this ID,
    /// optionally of one Tag. Two such Sessions are ambiguous and require the Tag.
    pub async fn get_session_delivery(
        &self,
        principal: &str,
        input: &GetSessionDeliveryRequest,
    ) -> Result<SessionDelivery> {
        name("Session ID", &input.session_id)?;
        if !input.tag_id.is_empty() {
            name("Tag ID", &input.tag_id)?;
        }
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query("SELECT h.tag_id,d.task_id,d.reference FROM supertag_v2_workspace_heads h JOIN supertag_v2_workspace_deliveries d ON d.attempt_id=h.attempt_id WHERE h.session_id=$1 AND ($2='' OR h.tag_id=$2) AND d.committed_at_ms IS NOT NULL ORDER BY h.tag_id")
            .bind(&input.session_id)
            .bind(&input.tag_id)
            .fetch_all(&mut *tx)
            .await?;
        let mut found = Vec::new();
        for row in rows {
            let task_id: String = row.try_get("task_id")?;
            if crate::conversations::task_access_in(&mut tx, principal, &task_id).await? {
                found.push(SessionDelivery {
                    task_id,
                    tag_id: row.try_get("tag_id")?,
                    session_id: input.session_id.clone(),
                    delivery: Some(decode_delivery(row.try_get("reference")?)?),
                });
            }
        }
        tx.commit().await?;
        match found.len() {
            0 => Err(StoreError::NotFound(
                "Session has no delivered Workspace commits".into(),
            )),
            1 => Ok(found.remove(0)),
            _ => Err(invalid(
                "more than one Tag has a Session with this ID; name the Tag",
            )),
        }
    }
}

/// The Worker Host holding a committed delivery's bytes, for a reader already authorized for
/// exactly this reference.
pub(crate) async fn delivery_holder_in(
    tx: &mut Transaction<'_, Any>,
    reference: &WorkspaceDeliveryReference,
) -> Result<BlobHolder> {
    let row = sqlx::query(
        "SELECT attempt_id,holder_host_id FROM supertag_v2_workspace_deliveries
         WHERE reference=$1 AND committed_at_ms IS NOT NULL",
    )
    .bind(reference.encode_to_vec())
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| StoreError::NotFound("Workspace delivery was not recorded".into()))?;
    let host_id: String = row.try_get("holder_host_id")?;
    if host_id.is_empty() {
        return Err(StoreError::NotFound(
            "Workspace delivery has no holding Worker Host".into(),
        ));
    }
    Ok(BlobHolder {
        host_id,
        attempt_id: row.try_get("attempt_id")?,
    })
}

impl Store {
    /// The Worker Host holding a committed delivery's bytes. Callers authorize the reference first.
    pub async fn workspace_delivery_holder(
        &self,
        reference: &WorkspaceDeliveryReference,
    ) -> Result<BlobHolder> {
        let mut tx = self.pool.begin().await?;
        let holder = delivery_holder_in(&mut tx, reference).await?;
        tx.commit().await?;
        Ok(holder)
    }

    /// Where a delivered Attempt's commits are besides its holding host: the delivering Task's
    /// remote Workspace, if it has one, and its Session branch.
    pub async fn delivery_source(
        &self,
        holder: &BlobHolder,
    ) -> Result<(Option<supertag_protocol::v2::Workspace>, String)> {
        let mut tx = self.pool.begin().await?;
        let task_id: String = sqlx::query_scalar(
            "SELECT task_id FROM supertag_v2_workspace_deliveries WHERE attempt_id=$1",
        )
        .bind(&holder.attempt_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StoreError::NotFound("Workspace delivery was not recorded".into()))?;
        let task = crate::store::task_in(&mut tx, &task_id).await?;
        tx.commit().await?;
        let branch = supertag_protocol::session_branch(&task.tag_id, &task.session_id);
        Ok((task.workspace.and_then(|spec| spec.remote), branch))
    }
}

pub(crate) async fn finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &AnyRow,
    input: &FinishTaskRequest,
) -> Result<()> {
    let spec = workspace_from_row(task)?;
    let Some(reference) = input.workspace_delivery.as_ref() else {
        return if spec.is_some() {
            Err(StoreError::FailedPrecondition(
                "successful workspace Task requires durable delivery".into(),
            ))
        } else {
            Ok(())
        };
    };
    if spec.is_none() {
        return Err(invalid("Task has no workspace"));
    }
    let bytes: Option<Vec<u8>> = sqlx::query_scalar("SELECT reference FROM supertag_v2_workspace_deliveries WHERE attempt_id=$1 AND task_id=$2 AND committed_at_ms IS NOT NULL")
        .bind(&input.attempt_id).bind(&input.task_id).fetch_optional(&mut **tx).await?;
    let accepted = bytes.ok_or_else(|| {
        StoreError::FailedPrecondition("workspace delivery has not been committed".into())
    })?;
    if &decode_delivery(accepted)? != reference {
        return Err(StoreError::Conflict(
            "Finish named a different workspace delivery".into(),
        ));
    }
    sqlx::query("UPDATE supertag_v2_tasks SET workspace_delivery=$1 WHERE task_id=$2")
        .bind(reference.encode_to_vec())
        .bind(&input.task_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO supertag_v2_workspace_heads (tag_id,session_id,attempt_id) VALUES ($1,$2,$3) ON CONFLICT(tag_id,session_id) DO UPDATE SET attempt_id=excluded.attempt_id")
        .bind(task.try_get::<String,_>("tag_id")?)
        .bind(task.try_get::<String,_>("session_id")?)
        .bind(&input.attempt_id)
        .execute(&mut **tx).await?;
    Ok(())
}

/// The Worker Host a queued Task of a local Workspace waits for: the host holding its Session's
/// last delivery, since a local Workspace's Session continues only where its commits are. `None`
/// when `claimer` is that host, the Task's Workspace is remote (any host reads its Session branch
/// from the remote), or the Session has no delivery yet.
pub(crate) async fn local_holder_wait_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    claimer: Option<&str>,
) -> Result<Option<String>> {
    if task
        .workspace
        .as_ref()
        .is_none_or(|spec| spec.remote.is_some())
    {
        return Ok(None);
    }
    let Some(row) = sqlx::query(
        "SELECT d.holder_host_id,d.reference FROM supertag_v2_workspace_heads h
         JOIN supertag_v2_workspace_deliveries d ON h.attempt_id=d.attempt_id
         WHERE h.tag_id=$1 AND h.session_id=$2 AND d.committed_at_ms IS NOT NULL",
    )
    .bind(&task.tag_id)
    .bind(&task.session_id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(None);
    };
    // A delivery that committed nothing leaves the Session at its base, which any host has.
    let delivery = decode_delivery(row.try_get("reference")?)?;
    if delivery.head_commit == delivery.base_commit {
        return Ok(None);
    }
    let holder: String = row.try_get("holder_host_id")?;
    Ok((!holder.is_empty() && claimer != Some(holder.as_str())).then_some(holder))
}

pub(crate) async fn continuation_in(
    tx: &mut Transaction<'_, Any>,
    task: &AnyRow,
) -> Result<Option<WorkspaceDeliveryReference>> {
    let bytes: Option<Vec<u8>> = sqlx::query_scalar("SELECT d.reference FROM supertag_v2_workspace_heads h JOIN supertag_v2_workspace_deliveries d ON h.attempt_id=d.attempt_id WHERE h.tag_id=$1 AND h.session_id=$2 AND d.committed_at_ms IS NOT NULL")
        .bind(task.try_get::<String,_>("tag_id")?)
        .bind(task.try_get::<String,_>("session_id")?)
        .fetch_optional(&mut **tx).await?;
    bytes.map(decode_delivery).transpose()
}

/// The stored form of a Workspace's followed branch: absent when it pins a commit.
pub(crate) fn encode_base_ref(workspace: Option<&WorkspaceSpec>) -> Option<&str> {
    workspace
        .filter(|spec| !spec.base_ref.is_empty())
        .map(|spec| spec.base_ref.as_str())
}

/// A Task of a Tag that follows a branch keeps the commit an earlier Task of its Session resolved
/// for the same Workspace and branch, so a Session never moves to a newer commit.
pub(crate) async fn bind_session_ref_in(
    tx: &mut Transaction<'_, Any>,
    (tag_id, session_id): (&str, &str),
    workspace: &mut Option<WorkspaceSpec>,
) -> Result<()> {
    let Some(spec) = workspace
        .as_mut()
        .filter(|spec| !spec.base_ref.is_empty() && spec.base_commit.is_empty())
    else {
        return Ok(());
    };
    let resolved: Option<String> = sqlx::query_scalar(
        "SELECT workspace_base_commit FROM supertag_v2_tasks
         WHERE tag_id=$1 AND session_id=$2 AND workspace_id=$3 AND workspace_base_ref=$4
           AND workspace_base_commit<>''
         ORDER BY accepted_order LIMIT 1",
    )
    .bind(tag_id)
    .bind(session_id)
    .bind(&spec.workspace_id)
    .bind(&spec.base_ref)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(resolved) = resolved {
        spec.base_commit = resolved;
    }
    Ok(())
}

/// Current policy compared with a Task that already resolved the branch it follows: the same
/// Workspace and branch keep that commit.
pub(crate) fn inherit_resolved_ref(
    current: &mut Option<WorkspaceSpec>,
    prior: Option<&WorkspaceSpec>,
) {
    if let (Some(current), Some(prior)) = (current, prior)
        && !current.base_ref.is_empty()
        && current.base_commit.is_empty()
        && current.workspace_id == prior.workspace_id
        && current.base_ref == prior.base_ref
    {
        current.base_commit = prior.base_commit.clone();
    }
}

/// Whether a Task keeps its Session's Workspace. Two Tasks that follow the same branch match even
/// when only one has resolved it yet; the Session's resolution then applies to both.
pub(crate) fn same_session_workspace(
    previous: Option<&WorkspaceSpec>,
    next: Option<&WorkspaceSpec>,
) -> bool {
    // A merge follow-up's commit and the commit authorship belong to one Task, not the Session.
    let session = |spec: &WorkspaceSpec| WorkspaceSpec {
        merge_commit: String::new(),
        author_name: String::new(),
        author_email: String::new(),
        co_author: String::new(),
        ..spec.clone()
    };
    let previous = previous.map(session);
    let next = next.map(session);
    match (previous.as_ref(), next.as_ref()) {
        (Some(previous), Some(next)) if !next.base_ref.is_empty() => {
            let unresolved = |spec: &WorkspaceSpec| WorkspaceSpec {
                base_commit: String::new(),
                ..spec.clone()
            };
            unresolved(previous) == unresolved(next)
        }
        _ => previous == next,
    }
}

pub(crate) fn workspace_from_row(row: &AnyRow) -> Result<Option<WorkspaceSpec>> {
    let id: Option<String> = row.try_get("workspace_id")?;
    let base: Option<String> = row.try_get("workspace_base_commit")?;
    let base_ref: Option<String> = row.try_get("workspace_base_ref")?;
    // Tag rows have no remote copy: admission resolves their configured catalog.
    let bytes = match row.try_get::<Vec<u8>, _>("workspace_remote") {
        Ok(bytes) => bytes,
        Err(sqlx::Error::ColumnNotFound(_)) => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let remote = if bytes.is_empty() {
        None
    } else {
        Some(crate::policy::decode(&bytes)?)
    };
    let merge_commit = match row.try_get::<String, _>("workspace_merge_commit") {
        Ok(commit) => commit,
        Err(sqlx::Error::ColumnNotFound(_)) => String::new(),
        Err(error) => return Err(error.into()),
    };
    match (id, base) {
        (Some(workspace_id), Some(base_commit)) => Ok(Some(WorkspaceSpec {
            workspace_id,
            base_commit,
            remote,
            merge_commit,
            mounts: crate::workspace_mounts::decode(row.try_get("workspace_mounts")?)?,
            mcp_servers: decode_mcp_servers(row.try_get("workspace_mcp_servers")?)?,
            base_ref: base_ref.unwrap_or_default(),
            ..Default::default()
        })),
        (None, None) => Ok(None),
        _ => Err(sqlx::Error::Protocol("incomplete stored workspace policy".into()).into()),
    }
}

/// A Workspace's selected `.mcp.json` servers as stored: absent when it selects none.
pub(crate) fn encode_mcp_servers(workspace: Option<&WorkspaceSpec>) -> Option<String> {
    workspace
        .filter(|spec| !spec.mcp_servers.is_empty())
        .map(|spec| serde_json::to_string(&spec.mcp_servers).expect("names serialize"))
}

fn decode_mcp_servers(value: Option<String>) -> Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = serde_json::from_str(&value)?;
    let stored = names.clone();
    if !supertag_protocol::mcp::normalize_workspace_servers(&mut names) || names != stored {
        return Err(sqlx::Error::Protocol("invalid stored Workspace MCP servers".into()).into());
    }
    Ok(names)
}

pub(crate) fn delivery_from_row(row: &AnyRow) -> Result<Option<WorkspaceDeliveryReference>> {
    row.try_get::<Option<Vec<u8>>, _>("workspace_delivery")?
        .map(decode_delivery)
        .transpose()
}

fn decode_delivery(bytes: Vec<u8>) -> Result<WorkspaceDeliveryReference> {
    WorkspaceDeliveryReference::decode(bytes.as_slice())
        .map_err(|error| sqlx::Error::Decode(Box::new(error)).into())
}

fn require_running(row: &AnyRow, now: i64) -> Result<()> {
    if row.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(row, now)? {
        return Err(StoreError::FailedPrecondition(
            "Attempt is not running with current authority".into(),
        ));
    }
    Ok(())
}

#[tonic::async_trait]
impl workspace_directory_server::WorkspaceDirectory for ControlPlane {
    async fn get_source(
        &self,
        request: Request<DownloadWorkspaceSourceRequest>,
    ) -> std::result::Result<Response<WorkspaceSourceBundle>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .get_workspace_source(&host, request.get_ref())
                .await?,
        ))
    }

    async fn get_review_artifact(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> std::result::Result<Response<HeldWorkspaceDelivery>, Status> {
        let host = self.host_authority(&request)?;
        let delivery = self
            .store
            .get_review_artifact(&host, &request.into_inner())
            .await?;
        let holder = self.store.workspace_delivery_holder(&delivery).await?;
        let (workspace, session_branch) = self.store.delivery_source(&holder).await?;
        Ok(Response::new(HeldWorkspaceDelivery {
            delivery: Some(delivery),
            holder: Some(holder),
            workspace,
            session_branch,
        }))
    }

    async fn get_continuation(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> std::result::Result<Response<WorkspaceContinuation>, Status> {
        let host = self.host_authority(&request)?;
        let delivery = self
            .store
            .get_workspace_continuation(&host, &request.into_inner())
            .await?;
        let holder = match &delivery {
            Some(delivery) => Some(self.store.workspace_delivery_holder(delivery).await?),
            None => None,
        };
        Ok(Response::new(WorkspaceContinuation { delivery, holder }))
    }

    async fn reserve_delivery(
        &self,
        request: Request<WorkspaceDeliveryRequest>,
    ) -> std::result::Result<Response<WorkspaceDeliveryReference>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .reserve_workspace_delivery(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn commit_delivery(
        &self,
        request: Request<WorkspaceDeliveryRequest>,
    ) -> std::result::Result<Response<WorkspaceDeliveryReference>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .commit_workspace_delivery(&host, &request.into_inner())
                .await?,
        ))
    }
}
