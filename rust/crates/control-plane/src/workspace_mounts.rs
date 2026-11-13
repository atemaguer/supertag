//! Workspace data Volume catalog and Task admission.
use crate::{
    ControlPlane, Store, StoreError,
    store::{Result, invalid},
};
use prost::Message;
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{
    v2::*,
    volumes::file_volume_path,
    workspace_mounts::{normalize_mounts, overlaps, volume_id},
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
    let row =
        sqlx::query("SELECT source,revision FROM supertag_v2_workspace_volumes WHERE volume_id=$1")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(missing)?;
    Ok(WorkspaceVolume {
        volume_id: id.into(),
        source: row.try_get("source")?,
        revision: row.try_get::<i64, _>("revision")? as u64,
    })
}

pub(crate) async fn source_allowed(tx: &mut Transaction<'_, Any>, source: &str) -> Result<bool> {
    let path = file_volume_path(source).map_err(|error| invalid(error.message()))?;
    let sources: Vec<String> = sqlx::query_scalar(
        "SELECT source FROM supertag_v2_artifact_volumes WHERE deleted=0 AND source LIKE 'file:%'",
    )
    .fetch_all(&mut **tx)
    .await?;
    for artifact in sources {
        let artifact = file_volume_path(&artifact).map_err(|error| invalid(error.message()))?;
        if overlaps(&path, &artifact) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) async fn allow_artifact_registration(
    tx: &mut Transaction<'_, Any>,
    source: &str,
) -> Result<()> {
    if !source.starts_with("file://") {
        return Ok(());
    }
    let artifact = file_volume_path(source).map_err(|error| invalid(error.message()))?;
    let sources: Vec<String> =
        sqlx::query_scalar("SELECT source FROM supertag_v2_workspace_volumes")
            .fetch_all(&mut **tx)
            .await?;
    for source in sources {
        let source = file_volume_path(&source).map_err(|error| invalid(error.message()))?;
        if overlaps(&source, &artifact) {
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
        || !matches!(
            HarnessKind::try_from(harness),
            Ok(HarnessKind::Codex | HarnessKind::Unspecified)
        )
        || !allowed.iter().any(|action| action == "files:read")
        || allowed.iter().any(|action| {
            matches!(
                action.as_str(),
                "commands:execute" | "files:write" | "web:fetch"
            )
        })
    {
        return Err(StoreError::FailedPrecondition(
            "Workspace mounts require local read-only Codex execution".into(),
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

impl Store {
    pub async fn put_workspace_volume(
        &self,
        input: &PutWorkspaceVolumeRequest,
    ) -> Result<WorkspaceVolume> {
        if !volume_id(&input.volume_id) {
            return Err(invalid("invalid Workspace Volume ID"));
        }
        file_volume_path(&input.source).map_err(|error| invalid(error.message()))?;
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
        if let Some(old) = old.filter(|old| old.source == input.source) {
            return Ok(old);
        }
        // Keep historical pins meaningful and prevent retargeting queued work.
        let revision = revision
            .checked_add(1)
            .and_then(|n| i64::try_from(n).ok())
            .ok_or_else(|| invalid("Workspace Volume revision exhausted"))?;
        sqlx::query("INSERT INTO supertag_v2_workspace_volumes (volume_id,source,revision) VALUES ($1,$2,$3) ON CONFLICT(volume_id) DO UPDATE SET source=excluded.source, revision=excluded.revision")
            .bind(&input.volume_id).bind(&input.source).bind(revision).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(WorkspaceVolume {
            volume_id: input.volume_id.clone(),
            source: input.source.clone(),
            revision: revision as u64,
        })
    }
}

#[tonic::async_trait]
impl workspace_volumes_server::WorkspaceVolumes for ControlPlane {
    async fn put(
        &self,
        request: Request<PutWorkspaceVolumeRequest>,
    ) -> std::result::Result<Response<WorkspaceVolume>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.put_workspace_volume(request.get_ref()).await?,
        ))
    }

    async fn get(
        &self,
        request: Request<GetWorkspaceVolumeRequest>,
    ) -> std::result::Result<Response<WorkspaceVolume>, Status> {
        self.principal(&request, "operator:")?;
        let mut tx = self.store.pool.begin().await.map_err(StoreError::from)?;
        Ok(Response::new(
            volume_in(&mut tx, &request.get_ref().volume_id).await?,
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
        let request = request.get_ref();
        let mut tx = self.store.pool.begin().await.map_err(StoreError::from)?;
        let row = crate::store::owned(
            &mut tx,
            &host,
            &request.task_id,
            &request.attempt_id,
            &request.lease_token,
        )
        .await?;
        crate::artifact_captures::running(&row, self.store.execution_now_ms())?;
        let task = crate::store::task_row(&row)?;
        if task
            .workspace
            .as_ref()
            .is_none_or(|workspace| workspace.mounts.is_empty())
            || !current_in(&mut tx, &task).await?
        {
            return Err(Status::failed_precondition(
                "Task has no current Workspace mount pins",
            ));
        }
        let sources: Vec<String> = sqlx::query_scalar(
            "SELECT source FROM supertag_v2_artifact_volumes WHERE deleted=0 AND source LIKE 'file:%' ORDER BY volume_id LIMIT 257",
        ).fetch_all(&mut *tx).await.map_err(StoreError::from)?;
        if sources.len() > 256 || sources.iter().map(String::len).sum::<usize>() > 512 * 1024 {
            return Err(Status::resource_exhausted(
                "too many artifact Volume protection paths",
            ));
        }
        Ok(Response::new(WorkspaceMountPreflight {
            protected_file_sources: sources,
        }))
    }
}
