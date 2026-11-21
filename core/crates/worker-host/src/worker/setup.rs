//! What a Worker resolves with the Control Plane before its harness starts: Workspace MCP
//! servers and Context Items.

use anyhow::Result;
use supertag_protocol::v2::{
    CommitContextResolutionRequest, RecordWorkspaceMcpRequest, ResolvedSkill, Task,
    attempt_mcp_effects_client::AttemptMcpEffectsClient,
};
use tokio_util::sync::CancellationToken;
use tonic::{Status, service::interceptor::InterceptedService, transport::Channel};

use crate::worker::Settings;
use crate::{
    HostHeaders, request,
    worker::{context, mcp},
    worklet::{authority::AttemptClient, journal::Attempt, workspaces},
};

/// Snapshots the Task's base commit, resolves its Workspace MCP servers there, and records
/// them with the Control Plane before any of them starts. A digest that differs from the one the
/// Task's first Attempt recorded is refused, so nothing starts.
pub(crate) async fn workspace_mcp(
    workspaces: &workspaces::Workspaces,
    (prepared, sandbox): (Option<&workspaces::PreparedWorkspace>, Option<&str>),
    task: &Task,
    (client, token): (
        &AttemptMcpEffectsClient<InterceptedService<Channel, HostHeaders>>,
        &str,
    ),
    cancel: &CancellationToken,
) -> Result<mcp::WorkspaceMcp, Status> {
    let prepared = prepared.ok_or_else(|| {
        Status::failed_precondition("Workspace MCP servers need a local Workspace checkout")
    })?;
    let snapshot = workspaces
        .mcp_snapshot(prepared, cancel)
        .await
        .map_err(|error| {
            crate::failures::noted(Status::internal("Workspace MCP snapshot failed"), &error)
        })?;
    let names = supertag_protocol::mcp::workspace_servers(task);
    let resolved =
        mcp::WorkspaceMcp::resolve(&snapshot, &names, mcp::workspace_mcp_variable, sandbox)
            .map_err(|error| Status::invalid_argument(format!("{error:#}")))?;
    client
        .clone()
        .record_workspace_mcp(
            request(
                RecordWorkspaceMcpRequest {
                    record: Some(resolved.record.clone()),
                },
                token,
            )
            .map_err(|error| {
                crate::failures::noted(
                    Status::internal("Workspace MCP record request failed"),
                    &error,
                )
            })?,
        )
        .await?;
    Ok(resolved)
}

/// Resolves the Task's Context Items and records the resolution with the Control Plane. The
/// repository Skills of its checkout's start commit, if it has one, are read here, after
/// checkout; they cannot be known when the host advertises what it resolves.
pub(crate) async fn prepare_context(
    options: &Settings<'_>,
    (task, attempt): (&Task, &Attempt),
    workspace: Option<(&workspaces::Workspaces, &workspaces::PreparedWorkspace)>,
    mut host: AttemptClient,
    token: &str,
    cancel: &CancellationToken,
) -> Result<Vec<ResolvedSkill>, Status> {
    let credential = |_| Status::internal("invalid Context Item authority request");
    let read_failed = |error: anyhow::Error| {
        crate::failures::noted(
            Status::failed_precondition("repository Skills could not be read"),
            &error,
        )
    };
    // A private directory outside the checkout, removed once the Skills are copied.
    let scratch = match workspace {
        Some((workspaces, prepared)) if options.context_catalog.resolves_skills(task) => {
            let scratch = tempfile::Builder::new()
                .prefix("repository-skills-")
                .permissions(
                    <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o700),
                )
                .tempdir_in(options.state_directory)
                .map_err(|error| read_failed(error.into()))?;
            let skipped = workspaces
                .repository_skills(prepared, scratch.path(), cancel)
                .await
                .map_err(read_failed)?;
            Some((scratch, prepared.checkout.start_commit.clone(), skipped))
        }
        _ => None,
    };
    let repository = scratch
        .as_ref()
        .map(|(scratch, commit, skipped)| context::RepositorySkills {
            root: scratch.path().to_owned(),
            commit: commit.clone(),
            skipped: skipped.clone(),
        });
    let expected = host
        .get_context_pins(
            request(supertag_protocol::v2::GetContextPinsRequest {}, token).map_err(credential)?,
        )
        .await?
        .into_inner();
    let prepared = options
        .context_catalog
        .prepare(
            task,
            options.state_directory,
            &attempt.attempt_id,
            &expected,
            repository,
            cancel,
        )
        .await
        .map_err(|error| {
            crate::failures::noted(
                Status::failed_precondition("Context Item could not be prepared"),
                &error,
            )
        })?;
    drop(scratch);
    let manifest = prepared.manifest().map_err(|error| {
        crate::failures::noted(Status::data_loss("invalid prepared Context Items"), &error)
    })?;
    let receipt = host
        .commit_context_resolution(
            request(
                CommitContextResolutionRequest {
                    manifest: Some(manifest.clone()),
                },
                token,
            )
            .map_err(credential)?,
        )
        .await?
        .into_inner();
    if receipt != manifest {
        return Err(Status::data_loss(
            "Context Item receipt has mismatched contents",
        ));
    }
    prepared.delivery().map_err(|error| {
        crate::failures::noted(Status::data_loss("invalid Context Item delivery"), &error)
    })
}
