use std::time::Duration;

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    output_policy::REQUIRED_OUTPUT_MISSING,
    v2::{HostRecord, Task},
};
use supertag_workspaces::TransferArtifact;
use tokio_util::sync::CancellationToken;
use tonic::Status;

use crate::{
    HostOptions,
    journal::{Attempt, Journal, RemoteSandboxState},
    remote_provider::RemoteProvider,
    task_outputs::PendingOutputs,
    workspaces::{PreparedWorkspace, Workspaces},
};

pub(crate) const CAPTURE_FAILED: &str = "Remote Workspace output could not be captured safely";
pub(crate) const OUTPUTS_FAILED: &str = "Task output files could not be captured safely";

pub(crate) async fn prepare(
    options: &HostOptions,
    journal: &Journal,
    workspaces: &Workspaces,
    (attempt, workspace, task): (&Attempt, &PreparedWorkspace, &Task),
    registration: &HostRecord,
    cancel: &CancellationToken,
) -> Result<RemoteProvider> {
    let config = options
        .remote_provider
        .as_ref()
        .context("remote Workspace provider is unavailable")?;
    ensure!(
        !task
            .allowed_actions
            .iter()
            .any(|action| action == "commands:execute"),
        "remote file Workspace cannot run commands"
    );
    let allowed_actions = task
        .allowed_actions
        .iter()
        .filter(|action| matches!(action.as_str(), "files:read" | "files:write"))
        .cloned()
        .collect::<Vec<_>>();
    let export = workspaces.export_remote(workspace, cancel).await?;
    let provider = RemoteProvider::spawn(config, &journal.remote_scratch()?, cancel).await?;
    ensure!(!cancel.is_cancelled(), "sandbox preparation cancelled");
    let record = journal.begin_remote_sandbox(
        attempt,
        &registration.host_id,
        registration.generation,
        config.authority_fingerprint(),
    )?;
    let timeout = options
        .attempt_timeout
        .saturating_add(Duration::from_secs(180))
        .min(Duration::from_secs(3600));
    let sandbox = provider
        .allocate(&record.owner(), timeout, &allowed_actions, cancel)
        .await?;
    journal.record_sandbox_active(&record, sandbox)?;
    provider
        .stage(&export.bundle, &export.checkout.start_commit, cancel)
        .await?;
    Ok(provider)
}

pub(crate) async fn capture(
    provider: &RemoteProvider,
    journal: &Journal,
    (attempt, workspace): (&Attempt, &PreparedWorkspace),
    outputs: Option<Box<PendingOutputs>>,
    state: &std::path::Path,
    cancel: &CancellationToken,
) -> Result<(TransferArtifact, Option<Box<PendingOutputs>>), Status> {
    let directory = journal
        .remote_scratch()
        .map_err(|_| Status::internal(CAPTURE_FAILED))?;
    let tree = provider
        .capture(&directory, cancel)
        .await
        .map_err(|_| Status::failed_precondition(CAPTURE_FAILED))?;
    let outputs = if let Some(outputs) = outputs {
        Some(Box::new(
            outputs
                .freeze_remote(workspace, tree.clone(), state, attempt, cancel)
                .await
                .map_err(|error| {
                    let message = if error
                        .downcast_ref::<Status>()
                        .is_some_and(|status| status.message() == REQUIRED_OUTPUT_MISSING)
                    {
                        REQUIRED_OUTPUT_MISSING
                    } else {
                        OUTPUTS_FAILED
                    };
                    Status::failed_precondition(message)
                })?,
        ))
    } else {
        None
    };
    Ok((tree, outputs))
}

pub(crate) async fn ensure_stopped(
    options: &HostOptions,
    journal: &Journal,
    attempt: &Attempt,
    registration: &HostRecord,
) -> Result<()> {
    let Some(record) = journal.remote_sandbox()? else {
        return Ok(());
    };
    let owner = record.owner();
    ensure!(
        owner.task_id == attempt.task_id && owner.attempt_id == attempt.attempt_id,
        "sandbox allocation belongs to another Attempt"
    );
    if matches!(record.state, RemoteSandboxState::Stopped { .. }) {
        return Ok(());
    }
    ensure!(
        owner.host_id == registration.host_id && owner.host_generation == registration.generation,
        "sandbox recovery requires the original Worker Host generation"
    );
    let config = options
        .remote_provider
        .as_ref()
        .context("sandbox recovery requires its Workspace provider")?;
    ensure!(
        record.provider_scope == config.authority_fingerprint(),
        "sandbox recovery requires the original provider authority"
    );
    // Cleanup must still run after cancellation. The provider client bounds each call.
    let cleanup = CancellationToken::new();
    let mut provider = RemoteProvider::spawn(config, &journal.remote_scratch()?, &cleanup).await?;
    let stopped = provider.stop(&owner, record.sandbox_id(), &cleanup).await;
    let closed = provider.shutdown().await;
    let stopped = stopped?.context("sandbox termination could not be confirmed")?;
    journal.record_sandbox_stopped(&record, stopped)?;
    closed
}
