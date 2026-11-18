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
    worker::adapter::artifact_acquisition::AcquisitionClient,
    worker::remote_provider::{RemoteProvider, Start},
    worker::task_artifact_inputs::RemoteInputs,
    worker::task_outputs::PendingOutputs,
    worklet::journal::{Attempt, Journal, RemoteSandboxState},
    worklet::workspaces::{PreparedWorkspace, Workspaces},
    workspace_mounts::{Mounted, WorkspaceMounts, record_remote, remote_writer},
};

/// Runtime actions a remote Workspace cannot carry: each would run on the Worker Host.
pub(crate) const REMOTE_REFUSED_ACTIONS: [&str; 3] = ["web:fetch", "web:search", "browser:use"];

/// The relay's loopback port in the sandbox, where Task clients connect (the SDK's
/// `EGRESS_CLIENT_PORT`).
const EGRESS_CLIENT_PORT: u16 = 3128;

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

/// When a Harness that starts before its sandbox must stop: the sandbox's lifetime less its
/// cleanup margin, counted from now. The sandbox is allocated later, so this is never later than
/// the deadline `prepare` reports.
pub(crate) fn execution_ends(options: &HostOptions, mounted: Option<&Mounted>) -> Instant {
    let margin = sandbox_margin(mounted);
    let timeout = options
        .attempt_timeout
        .saturating_add(margin)
        .min(MAX_SANDBOX_LIFETIME);
    Instant::now() + timeout.saturating_sub(margin)
}

/// What a sandbox's lifetime keeps after the Harness stops: cleanup, and time to capture its
/// read-write Workspace copies.
fn sandbox_margin(mounted: Option<&Mounted>) -> Duration {
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
    SANDBOX_CLEANUP_MARGIN.saturating_add(copy_capture_margin(read_write))
}

/// What the Harness reads about its Task artifact inputs and Workspace copies in a remote
/// sandbox: paths only, so it can start before the sandbox is prepared.
pub(crate) fn launch_instructions(
    inputs: &RemoteInputs,
    mounted: Option<&Mounted>,
    attempt: &Attempt,
) -> Result<Option<String>> {
    let mut instructions = inputs.instructions();
    if let Some(mounted) = mounted {
        instructions
            .get_or_insert_default()
            .push_str(&mounted.remote_instructions(&attempt.attempt_id)?);
    }
    Ok(instructions)
}

/// Downloads a Task's artifact inputs for its remote sandbox, which stages them later.
pub(crate) async fn download_inputs(
    attempt: &Attempt,
    task: &Task,
    (coordination, token): (&CoordinationClients, &str),
    cancel: &CancellationToken,
) -> Result<RemoteInputs, Status> {
    let acquisition = AcquisitionClient {
        coordination,
        host_token: token,
        attempt: attempt.inspect(),
    };
    RemoteInputs::download(&acquisition, task, cancel).await
}

pub(crate) async fn prepare(
    options: &HostOptions,
    journal: &Journal,
    workspaces: &Workspaces,
    (attempt, workspace, task): (&Attempt, &PreparedWorkspace, &Task),
    (mcp_commit, environment, mounted, downloaded): (
        Option<&str>,
        Option<RemoteDevcontainer>,
        Option<&Mounted>,
        Option<RemoteInputs>,
    ),
    (registration, coordination, token): (&HostRecord, &CoordinationClients, &str),
    (egress, cancel): (
        Option<&crate::worker::egress::AttemptEgress>,
        &CancellationToken,
    ),
) -> Result<(RemoteProvider, Option<String>, Instant, Restart)> {
    options
        .remote_provider
        .as_ref()
        .context("remote Workspace provider is unavailable")?;
    // A remote sandbox carries files and commands only. A web or browser action would run on
    // this host, outside the sandbox, so it is refused rather than dropped.
    if let Some(action) = task.allowed_actions.iter().find(|action| {
        REMOTE_REFUSED_ACTIONS.contains(&action.as_str())
                // A scoped web:fetch reaches the web through the sandbox's relay, never this host:
                // only on a relaying host, and only for a Task whose commands use it.
                && !(action.as_str() == "web:fetch"
                    && egress.is_some()
                    && options.execution_profile.remote_egress_relay
                    && task
                        .allowed_actions
                        .iter()
                        .any(|action| action == "commands:execute"))
    }) {
        anyhow::bail!("a remote Workspace cannot carry {action} yet");
    }
    // Commands run in the sandbox; the provider seals it before Capture. Coordination actions
    // stay with the Harness and never reach the provider.
    let allowed_actions = task
        .allowed_actions
        .iter()
        .filter(|action| {
            matches!(
                action.as_str(),
                "files:read" | "files:write" | "commands:execute"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let export = workspaces.export_remote(workspace, cancel).await?;
    let acquisition = AcquisitionClient {
        coordination,
        host_token: token,
        attempt: attempt.inspect(),
    };
    // Inputs downloaded before a Harness that started first are staged here, not fetched again.
    let inputs = match downloaded {
        Some(inputs) => inputs,
        None => RemoteInputs::download(&acquisition, task, cancel).await?,
    };
    // A devcontainer with lifecycle commands starts the Task's sandbox from a prepared artifact:
    // its image, trusted checkout, and setup are already there.
    let prepared = match environment
        .as_ref()
        .filter(|environment| environment.prepared)
    {
        Some(environment) => Some(
            crate::worker::prepared::artifact(
                options,
                journal,
                workspaces,
                (attempt, workspace),
                environment,
                registration,
                cancel,
            )
            .await?,
        ),
        None => None,
    };
    let margin = sandbox_margin(mounted);
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
    let (environment, start) = match prepared {
        Some(artifact) => (None, Start::Prepared(artifact)),
        None => (
            environment.map(|environment| RemoteWorkspaceEnvironment {
                image: environment.image,
                dockerfile_commands: environment.dockerfile_commands,
                user: environment.user,
                setup_commands: environment.setup_commands,
            }),
            Start::Fresh,
        ),
    };
    let setup = environment
        .as_ref()
        .is_some_and(|environment| !environment.setup_commands.is_empty());
    // A network scope reaches the sandbox only through its commands, so only they get the relay.
    let egress = egress
        .filter(|_| {
            allowed_actions
                .iter()
                .any(|action| action == "commands:execute")
        })
        .map(|egress| egress.remote(EGRESS_CLIENT_PORT));
    // Package managers' downloads persist per Workspace and Tag, for commands only.
    let dependency_cache = allowed_actions
        .iter()
        .any(|action| action == "commands:execute")
        .then(|| {
            dependency_cache_key(
                &registration.host_id,
                task.workspace
                    .as_ref()
                    .map_or("", |workspace| workspace.workspace_id.as_str()),
                &task.tag_id,
            )
        });
    let restart = Restart {
        allowed_actions,
        egress,
        dependency_cache,
        file_scope: supertag_protocol::file_scope::of_task(task).cloned(),
        environment,
        start,
        setup,
        inputs: inputs.files.clone(),
        mcp_commit: mcp_commit.map(str::to_owned),
        margin,
        execution_ends,
        replaced: 0,
    };
    let provider = start_sandbox(
        options,
        journal,
        (attempt, &export),
        mounted,
        registration,
        &restart,
        timeout,
        cancel,
    )
    .await?;
    let instructions = launch_instructions(&inputs, mounted, attempt)?;
    // Delivered only once staged in the sandbox.
    inputs.delivered(&acquisition, cancel).await?;
    Ok((provider, instructions, execution_ends, restart))
}

/// What a replacement sandbox needs to start from the Attempt's starting files, recorded when the
/// first sandbox was prepared.
#[derive(Clone)]
pub(crate) struct Restart {
    allowed_actions: Vec<String>,
    /// The relay to the Attempt's egress proxy each sandbox, a replacement too, gets.
    egress: Option<supertag_protocol::v2::RemoteWorkspaceEgress>,
    /// The dependency cache each sandbox, a replacement too, may reuse.
    dependency_cache: Option<String>,
    file_scope: Option<supertag_protocol::v2::FileScope>,
    environment: Option<RemoteWorkspaceEnvironment>,
    start: Start,
    setup: bool,
    inputs: Vec<(supertag_protocol::v2::ArtifactInputFile, Vec<u8>)>,
    mcp_commit: Option<String>,
    margin: Duration,
    /// When the Harness must stop; a replacement keeps it.
    execution_ends: Instant,
    /// How many sandboxes have replaced the first.
    pub(crate) replaced: u32,
}

/// The most sandboxes that may replace an Attempt's first one.
pub(crate) const MAX_REPLACEMENTS: u32 = 2;

/// What the Harness reads when its sandbox was replaced.
pub(crate) const SANDBOX_REPLACED: &str = "The sandbox stopped and was replaced. The new sandbox starts from this turn's starting files: changes made earlier in this turn, and any background processes, are gone. Make the changes again.";

/// Allocates and stages one sandbox of the Attempt from its starting files.
#[allow(clippy::too_many_arguments)]
async fn start_sandbox(
    options: &HostOptions,
    journal: &Journal,
    (attempt, export): (&Attempt, &supertag_workspaces::PreparedExport),
    mounted: Option<&Mounted>,
    registration: &HostRecord,
    restart: &Restart,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<RemoteProvider> {
    let config = options
        .remote_provider
        .as_ref()
        .context("remote Workspace provider is unavailable")?;
    let mut provider = RemoteProvider::spawn(config, &journal.remote_scratch()?, cancel).await?;
    if let Some(key) = &restart.dependency_cache {
        provider.set_dependency_cache(key.clone());
    }
    if let Some(egress) = &restart.egress {
        provider.set_egress(egress.clone());
    }
    ensure!(!cancel.is_cancelled(), "sandbox preparation cancelled");
    let record = journal.begin_remote_sandbox(
        attempt,
        &registration.host_id,
        registration.generation,
        config.authority_fingerprint(),
    )?;
    let sandbox = provider
        .allocate(
            &record.owner(),
            timeout,
            (&restart.allowed_actions, restart.file_scope.as_ref()),
            (restart.environment.clone(), &restart.start),
            cancel,
        )
        .await?;
    journal.record_sandbox_active(&record, sandbox)?;
    provider
        .stage(
            &export.bundle,
            &export.checkout.start_commit,
            &restart.inputs,
            restart.mcp_commit.as_deref(),
            restart.setup,
            cancel,
        )
        .await?;
    if let Some(mounted) = mounted {
        // Each copy was staged on this host with its Volume's credential; only
        // its files reach the sandbox.
        for copy in mounted.copies() {
            provider
                .stage_copy(copy, &attempt.attempt_id, cancel)
                .await?;
        }
    }
    Ok(provider)
}

/// Replaces a sandbox its provider found gone: once its stop is confirmed and journaled, a new
/// sandbox starts from the Attempt's starting files, with the same allocation and the time the
/// Harness has left. Fails, leaving the old sandbox's record, when the stop cannot be confirmed,
/// after `MAX_REPLACEMENTS`, or when the Harness has no time left.
pub(crate) async fn replace(
    options: &HostOptions,
    journal: &Journal,
    workspaces: &Workspaces,
    (attempt, workspace): (&Attempt, &PreparedWorkspace),
    (mounted, registration): (Option<&Mounted>, &HostRecord),
    restart: &mut Restart,
    cancel: &CancellationToken,
) -> Result<RemoteProvider> {
    ensure!(
        restart.replaced < MAX_REPLACEMENTS,
        "this Attempt already replaced its sandbox {MAX_REPLACEMENTS} times"
    );
    let left = restart
        .execution_ends
        .saturating_duration_since(Instant::now());
    ensure!(
        !left.is_zero(),
        "the Attempt has no time left for a new sandbox"
    );
    ensure_stopped(options, journal, attempt, registration).await?;
    let stopped = journal
        .remote_sandbox()?
        .context("the lost sandbox has no journal record")?;
    journal.retire_stopped_sandbox(&stopped)?;
    restart.replaced += 1;
    let export = workspaces.export_remote(workspace, cancel).await?;
    let timeout = left
        .saturating_add(restart.margin)
        .min(MAX_SANDBOX_LIFETIME);
    start_sandbox(
        options,
        journal,
        (attempt, &export),
        mounted,
        registration,
        restart,
        timeout,
        cancel,
    )
    .await
}

pub(crate) async fn capture(
    provider: &RemoteProvider,
    journal: &Journal,
    (workspace, workspaces, has_inputs): (&PreparedWorkspace, &Workspaces, bool),
    outputs: Option<Box<PendingOutputs>>,
    (state, copies): (&std::path::Path, Option<(&Mounted, &WorkspaceMounts)>),
    authority: (&crate::worklet::checkpoints::Transfers, &Attempt, &str),
    cancel: &CancellationToken,
) -> Result<(TransferArtifact, Option<Box<PendingOutputs>>), Status> {
    let directory = journal
        .remote_scratch()
        .map_err(|error| crate::failures::noted(Status::internal(CAPTURE_FAILED), &error))?;
    // The Task output directory returns even when the checkout's ignore rules match it.
    let keep = outputs
        .as_ref()
        .map(|outputs| vec![outputs.directory.clone()])
        .unwrap_or_default();
    let tree = provider
        .capture(&directory, &keep, cancel)
        .await
        .map_err(|error| {
            crate::failures::noted(Status::failed_precondition(CAPTURE_FAILED), &error)
        })?;
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
        .map_err(|error| crate::failures::noted(Status::internal(CAPTURE_FAILED), &error))?
        .map_err(|error| {
            crate::failures::noted(Status::failed_precondition(CAPTURE_FAILED), &error)
        })?;
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
            record_remote(state, attempt_id, copy.index, &listing).map_err(|error| {
                crate::failures::noted(Status::failed_precondition(COPY_CAPTURE_FAILED), &error)
            })?;
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
                        crate::failures::note(OUTPUTS_FAILED, &error);
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

/// The dependency cache a Tag's Task Attempts on a Workspace share on this Worker Host: a digest,
/// so the provider never learns the names. Another Tag, even on the same Workspace, gets another
/// cache, so a Tag with weaker permissions cannot plant packages another Tag later installs.
pub(crate) fn dependency_cache_key(host_id: &str, workspace_id: &str, tag_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"supertag-dependency-cache-v1\0");
    for value in [host_id, workspace_id, tag_id] {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

#[cfg(test)]
mod dependency_cache_tests {
    use super::dependency_cache_key;

    #[test]
    fn each_tag_on_a_workspace_gets_its_own_cache() {
        let key = dependency_cache_key("host", "repo", "builder");
        assert!(key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(key, dependency_cache_key("host", "repo", "builder"));
        for other in [
            dependency_cache_key("host", "repo", "reviewer"),
            dependency_cache_key("host", "other", "builder"),
            dependency_cache_key("other", "repo", "builder"),
            // Lengths are bound, so moving a boundary is another key.
            dependency_cache_key("host", "repob", "uilder"),
        ] {
            assert_ne!(key, other);
        }
    }
}
