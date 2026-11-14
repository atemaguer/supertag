//! Workspace data Volume catalog and Task admission.
use crate::{
    ControlPlane, HostAuthority, Store, StoreError,
    store::{Result, invalid},
};
use prost::Message;
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{
    v2::*,
    volumes::{file_volume_path, s3_volume_source},
    workspace_mounts::{
        mount_actions, mount_harness, normalize_mounts, overlaps, validate_volume, validate_writes,
        volume_id,
    },
};
use tonic::{Request, Response, Status};

#[derive(Message)]
struct Mounts {
    #[prost(message, repeated, tag = "1")]
    entries: Vec<WorkspaceCopyMount>,
}

pub(crate) fn encode(spec: Option<&WorkspaceSpec>) -> Option<Vec<u8>> {
    spec.filter(|spec| !spec.mounts.is_empty()).map(|spec| {
        Mounts {
            entries: spec.mounts.clone(),
        }
        .encode_to_vec()
    })
}

pub(crate) fn decode(bytes: Option<Vec<u8>>) -> Result<Vec<WorkspaceCopyMount>> {
    Ok(bytes
        .as_deref()
        .map(crate::policy::decode::<Mounts>)
        .transpose()?
        .map_or_else(Vec::new, |mounts| mounts.entries))
}

fn missing() -> StoreError {
    StoreError::NotFound("Workspace Volume was not found".into())
}

async fn volume_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<WorkspaceVolume> {
    let row = sqlx::query(
        "SELECT source,revision,credential FROM supertag_v2_workspace_volumes WHERE volume_id=$1",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(missing)?;
    Ok(WorkspaceVolume {
        volume_id: id.into(),
        source: row.try_get("source")?,
        revision: row.try_get::<i64, _>("revision")? as u64,
        credential: row.try_get("credential")?,
    })
}

/// Whether two Volume sources can reach the same data: file paths by
/// component (and on macOS by case and Unicode form), S3 sources by bucket
/// name and nested prefix on any endpoint.
fn sources_overlap(a: &str, b: &str) -> Result<bool> {
    let error = |status: tonic::Status| invalid(status.message());
    match (a.starts_with("s3://"), b.starts_with("s3://")) {
        (true, true) => {
            let (a_bucket, a_prefix) = s3_volume_source(a).map_err(error)?;
            let (b_bucket, b_prefix) = s3_volume_source(b).map_err(error)?;
            let within = |path: &str, base: &str| {
                path == base
                    || path
                        .strip_prefix(base)
                        .is_some_and(|rest| rest.starts_with('/'))
            };
            Ok(a_bucket == b_bucket && (within(a_prefix, b_prefix) || within(b_prefix, a_prefix)))
        }
        (false, false) => Ok(overlaps(
            &file_volume_path(a).map_err(error)?,
            &file_volume_path(b).map_err(error)?,
        )),
        _ => Ok(false),
    }
}

pub(crate) async fn source_allowed(tx: &mut Transaction<'_, Any>, source: &str) -> Result<bool> {
    let sources: Vec<String> =
        sqlx::query_scalar("SELECT source FROM supertag_v2_artifact_volumes WHERE deleted=0")
            .fetch_all(&mut **tx)
            .await?;
    for artifact in sources {
        if sources_overlap(source, &artifact)? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) async fn allow_artifact_registration(
    tx: &mut Transaction<'_, Any>,
    source: &str,
) -> Result<()> {
    let sources: Vec<String> =
        sqlx::query_scalar("SELECT source FROM supertag_v2_workspace_volumes")
            .fetch_all(&mut **tx)
            .await?;
    for workspace in sources {
        if sources_overlap(&workspace, source)? {
            return Err(StoreError::FailedPrecondition(
                "artifact Volume overlaps a Workspace data Volume".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) async fn configure_in(
    tx: &mut Transaction<'_, Any>,
    workspace: &mut Option<WorkspaceSpec>,
) -> Result<()> {
    let Some(spec) = workspace.as_mut().filter(|spec| !spec.mounts.is_empty()) else {
        return Ok(());
    };
    if spec.base_commit.is_empty() {
        return Err(invalid(
            "Workspace mounts require a local pinned Git Workspace",
        ));
    }
    normalize_mounts(&mut spec.mounts).map_err(|error| invalid(error.message()))?;
    for mount in &spec.mounts {
        if mount.volume.is_some() {
            return Err(invalid(
                "Workspace Volume pins are assigned at Task admission",
            ));
        }
        let volume = volume_in(tx, &mount.volume_id).await?;
        if !source_allowed(tx, &volume.source).await? {
            return Err(StoreError::FailedPrecondition(
                "Workspace Volume overlaps artifact storage".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) async fn admission_in(
    tx: &mut Transaction<'_, Any>,
    workspace: &mut Option<WorkspaceSpec>,
    allowed: &[String],
    harness: i32,
) -> Result<()> {
    let Some(spec) = workspace.as_mut().filter(|spec| !spec.mounts.is_empty()) else {
        return Ok(());
    };
    if spec.github_source.is_some()
        || !HarnessKind::try_from(harness)
            .is_ok_and(|kind| kind == HarnessKind::Unspecified || mount_harness(kind))
        || !mount_actions(&spec.mounts, allowed)
    {
        return Err(StoreError::FailedPrecondition(
            "Workspace mounts require a Codex, Claude Code, Cursor, or OpenCode Task that reads files, writes files for every read-write copy, and neither runs commands nor fetches from the web".into(),
        ));
    }
    for mount in &mut spec.mounts {
        let volume = volume_in(tx, &mount.volume_id).await?;
        if !source_allowed(tx, &volume.source).await? {
            return Err(StoreError::FailedPrecondition(
                "Workspace Volume overlaps artifact storage".into(),
            ));
        }
        mount.volume = Some(volume);
    }
    Ok(())
}

pub(crate) async fn current_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<bool> {
    let Some(workspace) = &task.workspace else {
        return Ok(true);
    };
    for mount in &workspace.mounts {
        let Some(pin) = &mount.volume else {
            return Ok(false);
        };
        match volume_in(tx, &mount.volume_id).await {
            Ok(volume) if volume == *pin && source_allowed(tx, &volume.source).await? => {}
            Ok(_) | Err(StoreError::NotFound(_)) => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

fn operator(principal: &str) -> Result<()> {
    principal
        .strip_prefix("operator:")
        .filter(|id| !id.is_empty())
        .map(|_| ())
        .ok_or(StoreError::PermissionDenied)
}

impl Store {
    /// Register or retarget an operator-owned file Volume for Workspace data.
    /// A new source gets a new revision, so pins on queued work stop matching.
    pub async fn put_workspace_volume(
        &self,
        principal: &str,
        input: &PutWorkspaceVolumeRequest,
    ) -> Result<WorkspaceVolume> {
        operator(principal)?;
        if !volume_id(&input.volume_id) {
            return Err(invalid("invalid Workspace Volume ID"));
        }
        validate_volume(&input.source, &input.credential)
            .map_err(|error| invalid(error.message()))?;
        let (mut tx, _) = self.write().await?;
        if !source_allowed(&mut tx, &input.source).await? {
            return Err(StoreError::FailedPrecondition(
                "Workspace Volume overlaps artifact storage".into(),
            ));
        }
        let old = match volume_in(&mut tx, &input.volume_id).await {
            Ok(volume) => Some(volume),
            Err(StoreError::NotFound(_)) => None,
            Err(error) => return Err(error),
        };
        let revision = old.as_ref().map_or(0, |volume| volume.revision);
        if revision != input.expected_revision {
            return Err(StoreError::Conflict(
                "Workspace Volume revision changed".into(),
            ));
        }
        if let Some(old) =
            old.filter(|old| old.source == input.source && old.credential == input.credential)
        {
            return Ok(old);
        }
        let revision = revision
            .checked_add(1)
            .and_then(|n| i64::try_from(n).ok())
            .ok_or_else(|| invalid("Workspace Volume revision exhausted"))?;
        sqlx::query("INSERT INTO supertag_v2_workspace_volumes (volume_id,source,revision,credential) VALUES ($1,$2,$3,$4) ON CONFLICT(volume_id) DO UPDATE SET source=excluded.source, revision=excluded.revision, credential=excluded.credential")
            .bind(&input.volume_id).bind(&input.source).bind(revision).bind(&input.credential).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(WorkspaceVolume {
            volume_id: input.volume_id.clone(),
            source: input.source.clone(),
            revision: revision as u64,
            credential: input.credential.clone(),
        })
    }

    pub async fn get_workspace_volume(
        &self,
        principal: &str,
        volume_id: &str,
    ) -> Result<WorkspaceVolume> {
        operator(principal)?;
        let mut tx = self.pool.begin().await?;
        volume_in(&mut tx, volume_id).await
    }

    /// Disclose file artifact Volume paths to the Worker Host that owns a
    /// running Attempt with current Workspace mount pins, for alias rejection.
    pub async fn workspace_mount_preflight(
        &self,
        host: &HostAuthority,
        request: &InspectAttemptRequest,
    ) -> Result<WorkspaceMountPreflight> {
        let mut tx = self.pool.begin().await?;
        let row = crate::store::owned(
            &mut tx,
            host,
            &request.task_id,
            &request.attempt_id,
            &request.lease_token,
        )
        .await?;
        crate::artifact_captures::running(&row, self.execution_now_ms())?;
        let task = crate::store::task_row(&row)?;
        if task
            .workspace
            .as_ref()
            .is_none_or(|workspace| workspace.mounts.is_empty())
            || !current_in(&mut tx, &task).await?
        {
            return Err(StoreError::FailedPrecondition(
                "Task has no current Workspace mount pins".into(),
            ));
        }
        let sources: Vec<String> = sqlx::query_scalar(
            "SELECT source FROM supertag_v2_artifact_volumes WHERE deleted=0 AND source LIKE 'file:%' ORDER BY volume_id LIMIT 257",
        )
        .fetch_all(&mut *tx)
        .await?;
        if sources.len() > 256 || sources.iter().map(String::len).sum::<usize>() > 512 * 1024 {
            return Err(StoreError::FailedPrecondition(
                "too many artifact Volume protection paths".into(),
            ));
        }
        Ok(WorkspaceMountPreflight {
            protected_file_sources: sources,
        })
    }

    /// Record what a running Attempt's read-write copies wrote back. The
    /// first record stands; an equal retry succeeds and a different one is
    /// refused.
    pub async fn record_workspace_mount_writes(
        &self,
        host: &HostAuthority,
        request: &RecordWorkspaceMountWritesRequest,
    ) -> Result<()> {
        let (mut tx, order) = self.write().await?;
        let row = crate::store::owned(
            &mut tx,
            host,
            &request.task_id,
            &request.attempt_id,
            &request.lease_token,
        )
        .await?;
        crate::artifact_captures::running(&row, self.execution_now_ms())?;
        let task = crate::store::task_row(&row)?;
        let mounts = task
            .workspace
            .as_ref()
            .map(|workspace| workspace.mounts.as_slice())
            .unwrap_or_default();
        validate_writes(&request.writes, mounts).map_err(|error| invalid(error.message()))?;
        let bytes = Writes {
            entries: request.writes.clone(),
        }
        .encode_to_vec();
        sqlx::query("INSERT INTO supertag_v2_workspace_mount_writes (task_id,attempt_id,recorded_order,writes) VALUES ($1,$2,$3,$4) ON CONFLICT(task_id,attempt_id) DO NOTHING")
            .bind(&request.task_id)
            .bind(&request.attempt_id)
            .bind(order)
            .bind(&bytes)
            .execute(&mut *tx)
            .await?;
        let stored: Vec<u8> = sqlx::query_scalar(
            "SELECT writes FROM supertag_v2_workspace_mount_writes WHERE task_id=$1 AND attempt_id=$2",
        )
        .bind(&request.task_id)
        .bind(&request.attempt_id)
        .fetch_one(&mut *tx)
        .await?;
        if stored != bytes {
            return Err(StoreError::Conflict(
                "Workspace mount writes were already recorded differently".into(),
            ));
        }
        tx.commit().await?;
        Ok(())
    }
}

#[derive(Message)]
struct Writes {
    #[prost(message, repeated, tag = "1")]
    entries: Vec<WorkspaceMountWrite>,
}

/// Every Attempt's recorded write summaries, oldest first.
pub(crate) async fn writes_for(
    pool: &sqlx::Pool<Any>,
    task_id: &str,
) -> Result<Vec<AttemptWorkspaceMountWrites>> {
    let rows = sqlx::query(
        "SELECT attempt_id,writes FROM supertag_v2_workspace_mount_writes WHERE task_id=$1 ORDER BY recorded_order",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(AttemptWorkspaceMountWrites {
                attempt_id: row.try_get("attempt_id")?,
                writes: crate::policy::decode::<Writes>(&row.try_get::<Vec<u8>, _>("writes")?)?
                    .entries,
            })
        })
        .collect()
}

#[tonic::async_trait]
impl workspace_volumes_server::WorkspaceVolumes for ControlPlane {
    async fn put(
        &self,
        request: Request<PutWorkspaceVolumeRequest>,
    ) -> std::result::Result<Response<WorkspaceVolume>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_workspace_volume(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn get(
        &self,
        request: Request<GetWorkspaceVolumeRequest>,
    ) -> std::result::Result<Response<WorkspaceVolume>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_workspace_volume(&principal, &request.get_ref().volume_id)
                .await?,
        ))
    }
}

#[tonic::async_trait]
impl attempt_workspace_mounts_server::AttemptWorkspaceMounts for ControlPlane {
    async fn preflight(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> std::result::Result<Response<WorkspaceMountPreflight>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .workspace_mount_preflight(&host, request.get_ref())
                .await?,
        ))
    }

    async fn record_writes(
        &self,
        request: Request<RecordWorkspaceMountWritesRequest>,
    ) -> std::result::Result<Response<RecordWorkspaceMountWritesResponse>, Status> {
        let host = self.host_authority(&request)?;
        self.store
            .record_workspace_mount_writes(&host, request.get_ref())
            .await?;
        Ok(Response::new(RecordWorkspaceMountWritesResponse {}))
    }
}
