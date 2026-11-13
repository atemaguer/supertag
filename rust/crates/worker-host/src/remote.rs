use std::time::Duration;

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    output_policy::REQUIRED_OUTPUT_MISSING,
    task_artifact_inputs::input_root,
    v2::{HostRecord, RemoteWorkspaceEnvironment, Task},
};
use supertag_workspaces::{TransferArtifact, devcontainer::RemoteDevcontainer};
use tokio_util::sync::CancellationToken;
use tonic::Status;

use crate::{
    CoordinationClients, HostOptions,
    adapter::artifact_acquisition::AcquisitionClient,
    journal::{Attempt, Journal, RemoteSandboxState},
    remote_provider::RemoteProvider,
    task_artifact_inputs::RemoteInputs,
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
    (mcp_commit, environment): (Option<&str>, Option<RemoteDevcontainer>),
    (registration, coordination, token): (&HostRecord, &CoordinationClients, &str),
    cancel: &CancellationToken,
) -> Result<(RemoteProvider, Option<String>)> {
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
    let acquisition = AcquisitionClient {
        coordination,
        host_token: token,
        attempt: attempt.inspect(),
    };
    let inputs = RemoteInputs::download(&acquisition, task, cancel).await?;
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
    let environment = environment.map(|environment| RemoteWorkspaceEnvironment {
        image: environment.image,
        dockerfile_commands: environment.dockerfile_commands,
        user: environment.user,
        setup_commands: environment.setup_commands,
    });
    let setup = environment
        .as_ref()
        .is_some_and(|environment| !environment.setup_commands.is_empty());
    let sandbox = provider
        .allocate(
            &record.owner(),
            timeout,
            &allowed_actions,
            environment,
            cancel,
        )
        .await?;
    journal.record_sandbox_active(&record, sandbox)?;
    provider
        .stage(
            &export.bundle,
            &export.checkout.start_commit,
            &inputs.files,
            mcp_commit,
            setup,
            cancel,
        )
        .await?;
    let instructions = inputs.delivered(&acquisition, cancel).await?;
    Ok((provider, instructions))
}

pub(crate) async fn capture(
    provider: &RemoteProvider,
    journal: &Journal,
    (workspace, workspaces, has_inputs): (&PreparedWorkspace, &Workspaces, bool),
    outputs: Option<Box<PendingOutputs>>,
    state: &std::path::Path,
    authority: (&crate::checkpoints::Transfers, &Attempt, &str),
    cancel: &CancellationToken,
) -> Result<(TransferArtifact, Option<Box<PendingOutputs>>), Status> {
    let directory = journal
        .remote_scratch()
        .map_err(|_| Status::internal(CAPTURE_FAILED))?;
    let tree = provider
        .capture(&directory, cancel)
        .await
        .map_err(|_| Status::failed_precondition(CAPTURE_FAILED))?;
    if has_inputs {
        let archive = tree.clone();
        let root = input_root(&authority.1.attempt_id);
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            supertag_workspaces::verify_return_excludes(&archive, &root, &cancel)
        })
        .await
        .map_err(|_| Status::internal(CAPTURE_FAILED))?
        .map_err(|_| Status::failed_precondition(CAPTURE_FAILED))?;
    }
    let outputs = if let Some(outputs) = outputs {
        Some(Box::new(
            outputs
                .freeze_remote(
                    (workspace, workspaces),
                    tree.clone(),
                    state,
                    authority,
                    cancel,
                )
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
