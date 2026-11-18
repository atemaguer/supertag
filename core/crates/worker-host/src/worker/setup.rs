//! What a Worker resolves with the Control Plane before its harness starts: Workspace MCP
//! servers and Context Items.

use anyhow::Result;
use supertag_protocol::v2::{
    CommitContextResolutionRequest, RecordWorkspaceMcpRequest, ResolvedSkill, Task,
    attempt_mcp_effects_client::AttemptMcpEffectsClient,
};
use tokio_util::sync::CancellationToken;
use tonic::{Status, service::interceptor::InterceptedService, transport::Channel};

use crate::{
    HostHeaders, HostOptions, RegisteredHost, request,
    worker::mcp,
    worklet::{journal::Attempt, workspaces},
};

/// Snapshots the Task's base commit, resolves its Workspace MCP servers there, and records
/// them with the Control Plane before any of them starts. A digest that differs from the one the
/// Task's first Attempt recorded is refused, so nothing starts.
pub(crate) async fn workspace_mcp(
    workspaces: &workspaces::Workspaces,
    (prepared, sandbox): (Option<&workspaces::PreparedWorkspace>, Option<&str>),
    task: &Task,
    (client, attempt, token): (
        &AttemptMcpEffectsClient<InterceptedService<Channel, HostHeaders>>,
        &Attempt,
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
                    attempt: Some(attempt.inspect()),
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

pub(crate) async fn prepare_context(
    options: &HostOptions,
    task: &Task,
    attempt: &Attempt,
    mut host: RegisteredHost,
    token: &str,
    cancel: &CancellationToken,
) -> Result<Vec<ResolvedSkill>, Status> {
    let credential = |_| Status::internal("invalid Context Item authority request");
    let expected = host
        .get_context_pins(request(attempt.inspect(), token).map_err(credential)?)
        .await?
        .into_inner();
    let prepared = options
        .context_catalog
        .prepare(
            task,
            &options.state_directory,
            &attempt.attempt_id,
            &expected,
            cancel,
        )
        .await
        .map_err(|error| {
            crate::failures::noted(
                Status::failed_precondition("Context Item could not be prepared"),
                &error,
            )
        })?;
    let manifest = prepared.manifest().map_err(|error| {
        crate::failures::noted(Status::data_loss("invalid prepared Context Items"), &error)
    })?;
    let receipt = host
        .commit_context_resolution(
            request(
                CommitContextResolutionRequest {
                    attempt: Some(attempt.inspect()),
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
