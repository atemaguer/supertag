use std::time::Duration;

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    output_policy::REQUIRED_OUTPUT_MISSING,
    task_artifact_inputs::input_root,
    v2::{HostRecord, RemoteWorkspaceEnvironment, Task},
};
use supertag_workspaces::{TransferArtifact, devcontainer::RemoteDevcontainer};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tonic::Status;

use crate::{
    CoordinationClients, HostOptions,
    adapter::artifact_acquisition::AcquisitionClient,
    journal::{Attempt, Journal, RemoteSandboxState},
    remote_provider::RemoteProvider,
    task_artifact_inputs::RemoteInputs,
    task_outputs::PendingOutputs,
    workspace_mounts::{Mounted, WorkspaceMounts, record_remote, remote_writer},
    workspaces::{PreparedWorkspace, Workspaces},
};

/// The longest sandbox lifetime the E2B and Modal provider sessions grant.
pub(crate) const MAX_SANDBOX_LIFETIME: Duration = Duration::from_secs(3600);
/// Sandbox life kept after the harness stops, for capture and cleanup.
const SANDBOX_CLEANUP_MARGIN: Duration = Duration::from_secs(180);
/// The rate, in bytes per second, at which sandbox life is kept for capturing
/// read-write copies: the sandbox hashes what each copy staged and up to its
/// limit, then returns up to its limit.
const COPY_CAPTURE_RATE: u64 = 32 * 1024 * 1024;

/// Sandbox life kept after the harness stops to capture read-write copies,
/// each given as its staged bytes and its byte limit.
fn copy_capture_margin(read_write: impl Iterator<Item = (u64, u64)>) -> Duration {
    let bytes = read_write
        .map(|(staged, max_bytes)| staged.saturating_add(max_bytes.saturating_mul(2)))
        .fold(0u64, u64::saturating_add);
    Duration::from_secs(bytes.div_ceil(COPY_CAPTURE_RATE))
}

/// The Attempt time limit must be positive, and a remote sandbox must outlive it.
pub(crate) fn validate_time_limit(limit: Duration, remote: bool) -> Result<()> {
    ensure!(!limit.is_zero(), "attempt timeout must be positive");
    ensure!(
        !remote || limit <= MAX_SANDBOX_LIFETIME,
        "a remote Workspace sandbox lives at most {} seconds, so the attempt timeout cannot exceed it",
        MAX_SANDBOX_LIFETIME.as_secs()
    );
    Ok(())
}

pub(crate) const CAPTURE_FAILED: &str = "Remote Workspace output could not be captured safely";
pub(crate) const COPY_CAPTURE_FAILED: &str =
    "Remote Workspace Volume copies could not be captured safely";
pub(crate) const OUTPUTS_FAILED: &str = "Task output files could not be captured safely";

pub(crate) async fn prepare(
    options: &HostOptions,
    journal: &Journal,
    workspaces: &Workspaces,
    (attempt, workspace, task): (&Attempt, &PreparedWorkspace, &Task),
    (mcp_commit, environment, mounted): (
        Option<&str>,
        Option<RemoteDevcontainer>,
        Option<&Mounted>,
    ),
    (registration, coordination, token): (&HostRecord, &CoordinationClients, &str),
    cancel: &CancellationToken,
) -> Result<(RemoteProvider, Option<String>, Instant)> {
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
    let read_write = mounted.into_iter().flat_map(|mounted| {
        mounted
            .copies()
            .iter()
            .filter(|copy| copy.read_write)
            .map(|copy| {
                (
                    copy.files.iter().map(|file| file.size).sum(),
                    copy.max_bytes,
                )
            })
    });
    let margin = SANDBOX_CLEANUP_MARGIN.saturating_add(copy_capture_margin(read_write));
    let timeout = options
        .attempt_timeout
        .saturating_add(margin)
        .min(MAX_SANDBOX_LIFETIME);
    ensure!(
        timeout > margin,
        "Workspace copies leave a remote sandbox no time for the Harness; lower their byte limits"
    );
    // The sandbox's clock starts no earlier than this request, so the harness stops in time
    // to leave the cleanup margin, and time to capture read-write copies, even when
    // preparation took part of the lifetime.
    let execution_ends = Instant::now() + timeout - margin;
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
    let mut instructions = inputs.delivered(&acquisition, cancel).await?;
    if let Some(mounted) = mounted {
        // Each copy was staged on this host with its Volume's credential; only
        // its files reach the sandbox.
        for copy in mounted.copies() {
            provider
                .stage_copy(copy, &attempt.attempt_id, cancel)
                .await?;
        }
        instructions
            .get_or_insert_default()
            .push_str(&mounted.remote_instructions(&attempt.attempt_id)?);
    }
    Ok((provider, instructions, execution_ends))
}

pub(crate) async fn capture(
    provider: &RemoteProvider,
    journal: &Journal,
    (workspace, workspaces, has_inputs): (&PreparedWorkspace, &Workspaces, bool),
    outputs: Option<Box<PendingOutputs>>,
    (state, copies): (&std::path::Path, Option<(&Mounted, &WorkspaceMounts)>),
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
    let attempt_id = &authority.1.attempt_id;
    let mut excluded = vec![];
    if has_inputs {
        excluded.push(input_root(attempt_id));
    }
    if copies.is_some() {
        excluded.push(supertag_protocol::workspace_mounts::remote_copy_root(
            attempt_id,
        ));
    }
    for root in excluded {
        let archive = tree.clone();
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            supertag_workspaces::verify_return_excludes(&archive, &root, &cancel)
        })
        .await
        .map_err(|_| Status::internal(CAPTURE_FAILED))?
        .map_err(|_| Status::failed_precondition(CAPTURE_FAILED))?;
    }
    if let Some((mounted, mounts)) = copies {
        // Read-write copies come back into their host copies, which the
        // journaled write-back then writes to their Volumes.
        for copy in mounted.copies().iter().filter(|copy| copy.read_write) {
            let listing = provider
                .capture_copy(
                    copy,
                    attempt_id,
                    |listing| {
                        listing
                            .writable(copy.max_bytes)
                            .then(|| remote_writer(mounts, state, attempt_id, copy.index))
                            .transpose()
                    },
                    cancel,
                )
                .await
                .map_err(|error| {
                    supertag_protocol::terminal_text::warn(&format!(
                        "Remote Workspace Volume copy capture failed: {error:#}"
                    ));
                    Status::failed_precondition(COPY_CAPTURE_FAILED)
                })?;
            record_remote(state, attempt_id, copy.index, &listing)
                .map_err(|_| Status::failed_precondition(COPY_CAPTURE_FAILED))?;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remote_sandbox_must_outlive_the_attempt_time_limit() {
        assert!(validate_time_limit(Duration::ZERO, false).is_err());
        assert!(validate_time_limit(Duration::from_secs(86_400), false).is_ok());
        assert!(validate_time_limit(MAX_SANDBOX_LIFETIME, true).is_ok());
        assert!(validate_time_limit(MAX_SANDBOX_LIFETIME + Duration::from_secs(1), true).is_err());
    }

    #[test]
    fn read_write_copies_keep_sandbox_life_for_their_capture() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(copy_capture_margin(std::iter::empty()), Duration::ZERO);
        // A default 1 GiB copy that staged 1 GiB: listing 2 GiB, returning 1 GiB.
        assert_eq!(
            copy_capture_margin([(GIB, GIB)].into_iter()),
            Duration::from_secs(96)
        );
        // The largest copy still leaves the Harness most of a sandbox's hour.
        let largest = copy_capture_margin([(20 * GIB, 20 * GIB)].into_iter());
        assert_eq!(largest, Duration::from_secs(1920));
        assert!(largest + SANDBOX_CLEANUP_MARGIN < MAX_SANDBOX_LIFETIME);
    }
}
