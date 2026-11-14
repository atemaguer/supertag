mod adapter;
mod artifact_direct;
mod artifact_inputs;
mod artifact_snapshots;
mod changed_paths;
mod checkpoints;
mod cleanup_failure;
pub mod context;
mod credentials;
mod enrollment;
pub mod environment;
mod guardian;
mod journal;
mod mcp;
mod prepared;
mod readiness;
mod remote;
mod remote_provider;
mod shared_execution;
mod shared_host;
mod task_artifact_inputs;
mod task_outputs;
mod workspace_mounts;
mod workspaces;

pub use artifact_direct::{ArtifactPeers, ArtifactSourceConfig};
pub use credentials::{provider_environment, provider_environment_for, validate_opencode_model};
pub use enrollment::{
    EnrolledRole, credential, enroll, enrolled_control_plane, enrolled_host, rotate_own_credential,
};
pub use guardian::{ADAPTER_STATE_DIRECTORY, guard_adapter};
pub use mcp::{
    McpCatalog, McpCatalogEntry, McpLogin, McpLoginOptions, McpLoginState, McpLoginStore,
    login_command as mcp_login_command, run_mcp_login,
};
pub use readiness::{LaneObserver, State as LaneState, host_labels};
pub use remote_provider::{ProviderAuthority, ProviderConfig};
pub use shared_execution::SharedExecutionConfig;
pub use shared_host::{HarnessSlots, SharedHost, holds_attempt, transient as presence_retryable};
pub use workspace_mounts::WorkspaceMounts;
pub use workspaces::{WORKSPACE_DIRECTORY, WorkspaceMapping, WorkspaceSource};

use std::{ffi::OsString, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use journal::{Attempt, Entry, Journal};
use prost::Message;
use supertag_protocol::{
    HOST_GENERATION_HEADER, MAX_MESSAGE_BYTES, authenticated_request,
    negotiation::{self, NegotiationError},
    v2::{
        Assignment, AttemptExecutionSelection, ClaimTaskRequest, CommitContextResolutionRequest,
        FinishTaskRequest, HarnessCompleteRequest, HarnessExecutionProfile, HarnessKind,
        HostRecord, InspectAttemptRequest, ReclaimAttemptRequest, RecordWorkspaceMcpRequest,
        RecordWorkspaceMountWritesRequest, RegisterHostRequest, ResolveWorkspaceRefRequest,
        ResolvedSkill, ServiceRole, StartTaskRequest, Task, TaskState, WorkspaceMountWriteStatus,
        artifact_transfers_client::ArtifactTransfersClient,
        attempt_artifacts_client::AttemptArtifactsClient,
        attempt_changed_paths_client::AttemptChangedPathsClient,
        attempt_effects_client::AttemptEffectsClient, attempt_inputs_client::AttemptInputsClient,
        attempt_mailbox_client::AttemptMailboxClient,
        attempt_mcp_effects_client::AttemptMcpEffectsClient,
        attempt_work_sessions_client::AttemptWorkSessionsClient,
        attempt_workspace_mounts_client::AttemptWorkspaceMountsClient,
        attempt_workstreams_client::AttemptWorkstreamsClient, worker_host_client::WorkerHostClient,
    },
};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use tonic::{
    Code, Request, Status,
    metadata::{Ascii, MetadataValue},
    service::{Interceptor, interceptor::InterceptedService},
    transport::Channel,
};
use uuid::Uuid;

pub struct HostOptions {
    pub control_plane: supertag_transport::Target,
    pub token: Option<String>,
    pub state_directory: PathBuf,
    pub adapter_guardian: PathBuf,
    pub adapter: PathBuf,
    pub adapter_args: Vec<OsString>,
    pub harness: HarnessKind,
    pub provider_model: Option<String>,
    pub execution_profile: HarnessExecutionProfile,
    pub attempt_timeout: Duration,
    pub wait_for_recovery: bool,
    pub once: bool,
    /// Every Workspace this host can prepare. Several IDs may name one source.
    pub workspaces: Vec<WorkspaceMapping>,
    pub remote_provider: Option<ProviderConfig>,
    pub shared_execution: Option<SharedExecutionConfig>,
    pub context_catalog: context::ContextCatalog,
    pub mcp_catalog: McpCatalog,
    pub artifact_source: Option<ArtifactSourceConfig>,
    pub artifact_peers: ArtifactPeers,
    pub workspace_mounts: WorkspaceMounts,
    /// Where reports sample free disk space, normally the state directory's filesystem.
    pub disk_space: environment::DiskSpaceSource,
    /// The OS command that keeps the machine awake while an Attempt runs, if any.
    pub keep_awake: Option<environment::KeepAwakeCommand>,
    /// Operator-declared placement labels. The host adds its operating system
    /// and architecture; the Control Plane derives harness and Workspace labels.
    pub labels: Vec<String>,
    /// Set when a supervisor runs this process as one execution lane of a shared Host.
    pub lane: Option<Lane>,
}

/// One supervised execution lane. Every lane of a Host registers the Host's single
/// incarnation, so sibling lanes never replace each other's generation. The supervisor
/// owns the Host's presence report and receives this lane's state instead.
#[derive(Clone)]
pub struct Lane {
    pub incarnation_id: String,
    pub observer: LaneObserver,
    /// Cancelled when the supervisor lowers the Host's concurrency below this lane: the lane
    /// claims no more work and returns once it holds no Attempt, so its journal is left empty.
    pub retire: CancellationToken,
}

#[derive(Clone)]
pub(crate) struct HostHeaders {
    generation: MetadataValue<Ascii>,
    protocol: negotiation::ProtocolVersion,
}

impl HostHeaders {
    /// Names a registered generation and the protocol version this host
    /// negotiated with its Control Plane on every call.
    pub(crate) fn new(generation: u64, protocol: u32) -> Self {
        Self {
            generation: MetadataValue::from(generation),
            protocol: negotiation::ProtocolVersion::new(protocol),
        }
    }
}

impl Interceptor for HostHeaders {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, Status> {
        request
            .metadata_mut()
            .insert(HOST_GENERATION_HEADER, self.generation.clone());
        self.protocol.call(request)
    }
}

pub(crate) type RegisteredHost = WorkerHostClient<InterceptedService<Channel, HostHeaders>>;
pub(crate) type RegisteredInputs = AttemptInputsClient<InterceptedService<Channel, HostHeaders>>;
#[derive(Clone)]
pub(crate) struct CoordinationClients {
    transfers: checkpoints::Transfers,
    acquisitions: AttemptArtifactsClient<InterceptedService<Channel, HostHeaders>>,
    artifact_source: Option<artifact_direct::SourceStorage>,
    artifact_peers: ArtifactPeers,
    workspace_mounts: AttemptWorkspaceMountsClient<InterceptedService<Channel, HostHeaders>>,
    artifacts: ArtifactTransfersClient<InterceptedService<Channel, HostHeaders>>,
    workstreams: AttemptWorkstreamsClient<InterceptedService<Channel, HostHeaders>>,
    mailbox: AttemptMailboxClient<InterceptedService<Channel, HostHeaders>>,
    work_sessions: AttemptWorkSessionsClient<InterceptedService<Channel, HostHeaders>>,
    mcp_effects: AttemptMcpEffectsClient<InterceptedService<Channel, HostHeaders>>,
    changed_paths: AttemptChangedPathsClient<InterceptedService<Channel, HostHeaders>>,
    effects: AttemptEffectsClient<InterceptedService<Channel, HostHeaders>>,
}

impl Attempt {
    fn from_assignment(assignment: Assignment) -> Result<Self> {
        let task = assignment.task.context("assignment has no Task")?;
        ensure!(
            task.attempt_id.as_deref() == Some(assignment.attempt_id.as_str()),
            "assignment has mismatched Attempt identity"
        );
        let requires_unsandboxed_commands =
            task.attempt_execution.as_ref().is_some_and(|attempt| {
                matches!(
                    attempt.harness_kind(),
                    HarnessKind::Opencode | HarnessKind::Cursor
                ) && attempt.shared_execution.is_none()
                    && task
                        .allowed_actions
                        .iter()
                        .any(|action| action == "commands:execute")
            });
        Ok(Self {
            task_id: task.task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
            execution_selection: task
                .attempt_execution
                .map(|selection| selection.encode_to_vec()),
            requires_unsandboxed_commands,
        })
    }

    fn can_launch(&self, options: &HostOptions) -> Result<bool> {
        let Some(selection) = &self.execution_selection else {
            return Ok(false);
        };
        let execution = AttemptExecutionSelection::decode(selection.as_slice())
            .context("stored Attempt execution selection is invalid")?;
        let model = execution
            .selection
            .as_ref()
            .and_then(|selection| selection.model.as_ref());
        Ok(execution.harness_kind == options.harness as i32
            && execution.remote_file_workspace == options.execution_profile.remote_file_workspace
            && execution.shared_execution == options.execution_profile.shared_execution
            && (!execution.task_artifact_inputs || options.execution_profile.task_artifact_inputs)
            && execution
                .mcp_servers
                .iter()
                .all(|server| options.execution_profile.mcp_servers.contains(server))
            && model.is_none_or(|model| options.execution_profile.model_ids.contains(model))
            && (!self.requires_unsandboxed_commands
                || options.execution_profile.allow_unsandboxed_commands))
    }

    fn inspect(&self) -> InspectAttemptRequest {
        InspectAttemptRequest {
            task_id: self.task_id.clone(),
            attempt_id: self.attempt_id.clone(),
            lease_token: self.lease_token.clone(),
        }
    }
}

fn claim_request(
    options: &HostOptions,
    workspaces: &workspaces::Workspaces,
    operation_id: String,
) -> ClaimTaskRequest {
    ClaimTaskRequest {
        operation_id,
        workspace_ids: workspaces.ids(),
        gateway_workspace_ids: workspaces.control_plane_ids(),
        harness_kind: options.harness as i32,
        context_contracts: options.context_catalog.supported_contracts(),
        execution_profile: Some(McpCatalog::advertised(
            &options.execution_profile,
            &options.mcp_catalog.lapsed_logins(),
        )),
    }
}

pub async fn run(
    mut options: HostOptions,
    shutdown: CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    remote::validate_time_limit(options.attempt_timeout, options.remote_provider.is_some())?;
    ensure!(
        options.execution_profile.mcp_servers == options.mcp_catalog.capabilities()
            && (options.execution_profile.mcp_servers.is_empty()
                || (options.harness == HarnessKind::ClaudeCode
                    && options.remote_provider.is_none())),
        "MCP tools require a local Claude Code Worker Host with the matching catalog"
    );
    provider_environment_for(options.harness, options.provider_model.as_deref())?;
    let labels = readiness::host_labels(&options.labels)?;
    ensure!(
        options.execution_profile.remote_file_workspace == options.remote_provider.is_some()
            && (options.remote_provider.is_none()
                || (options.harness == HarnessKind::Cursor
                    && !options.workspaces.is_empty()
                    && !options.execution_profile.allow_unsandboxed_commands)),
        "invalid Worker Host remote Workspace profile"
    );
    ensure!(
        options.execution_profile.shared_execution.as_ref()
            == options
                .shared_execution
                .as_ref()
                .map(SharedExecutionConfig::capability)
            && (options.shared_execution.is_none()
                || (options.harness == HarnessKind::Cursor
                    && options.workspaces.is_empty()
                    && options.remote_provider.is_none()
                    && options.execution_profile.mcp_servers.is_empty()
                    && !options.execution_profile.allow_unsandboxed_commands)),
        "shared execution requires a Cursor Worker Host with the exact provider profile"
    );
    ensure!(
        !matches!(
            options.harness,
            HarnessKind::Opencode | HarnessKind::OpenaiAgents | HarnessKind::Cursor
        ) || options.context_catalog.supported_contracts().is_empty(),
        "the selected harness does not load Skills"
    );
    let shutdown = shutdown.child_token();
    let journal = Arc::new(Journal::open(&options.state_directory)?);
    let local_roots: Vec<PathBuf> = options
        .workspaces
        .iter()
        .filter_map(workspaces::WorkspaceMapping::local_root)
        .map(std::path::Path::to_path_buf)
        .collect();
    let local_roots: Vec<&std::path::Path> = local_roots.iter().map(PathBuf::as_path).collect();
    if !options.workspace_mounts.is_empty() {
        ensure!(
            supertag_protocol::workspace_mounts::mount_harness(options.harness)
                && !options.workspaces.is_empty()
                && local_roots.len() == options.workspaces.len()
                && options.shared_execution.is_none(),
            "Workspace copy mounts require a Codex, Claude Code, Cursor, or OpenCode Worker Host with local Workspace mappings"
        );
        let state_directory = options.state_directory.clone();
        let artifact_storage = options
            .artifact_source
            .as_ref()
            .map(|source| source.directory.clone());
        options.workspace_mounts.protect(
            &state_directory,
            &local_roots,
            artifact_storage.as_deref(),
        )?;
    }
    let workspaces =
        workspaces::Workspaces::new(&options.state_directory, options.workspaces.clone())?;
    // Terminal proof is durable; finishing local cleanup needs neither the source
    // repository nor a new network registration.
    if let Some(Entry::Terminal { attempt, prepared }) = journal.load()? {
        cleanup_terminal(
            &journal,
            &workspaces,
            &options.state_directory,
            &attempt,
            prepared.as_deref(),
        )?;
        if options.once {
            ready();
            return Ok(());
        }
    }
    let token = match &options.token {
        Some(token) if !token.is_empty() => token.clone(),
        Some(_) => bail!("Worker Host credential is empty"),
        None if options.lane.is_some() => bail!("a supervised lane needs its Host credential"),
        None => enrollment::host_token(&journal, &options.control_plane)?,
    };
    let incarnation_id = match &options.lane {
        Some(lane) => {
            Uuid::parse_str(&lane.incarnation_id).context("invalid shared Host incarnation")?;
            lane.incarnation_id.clone()
        }
        None => journal.incarnation()?,
    };
    let channel = options.control_plane.clone().connect_lazy();
    let (registration, protocol) = loop {
        if shutdown.is_cancelled() {
            return Ok(());
        }
        // Refuse an incompatible Control Plane before registering for work.
        let protocol = match negotiation::negotiate(
            channel.clone(),
            ServiceRole::WorkerHost,
            ServiceRole::ControlPlane,
        )
        .await
        {
            Ok(version) => version,
            Err(NegotiationError::Unavailable(_)) => {
                wait_for_work(&shutdown).await;
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let response = WorkerHostClient::new(negotiation::bind(channel.clone(), protocol))
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .register_host(request(
                RegisterHostRequest {
                    incarnation_id: incarnation_id.clone(),
                },
                &token,
            )?)
            .await;
        match response {
            Ok(response) => {
                let host = response.into_inner();
                ensure!(
                    !host.revoked && host.generation > 0,
                    "Worker Host registration is inactive"
                );
                break (host, protocol);
            }
            Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
            Err(error) => return Err(error.into()),
        }
    };
    let headers = HostHeaders::new(registration.generation, protocol);
    let inputs = AttemptInputsClient::with_interceptor(
        options.control_plane.clone().connect_lazy(),
        headers.clone(),
    )
    .max_decoding_message_size(MAX_MESSAGE_BYTES)
    .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let acquisitions = AttemptArtifactsClient::with_interceptor(channel.clone(), headers.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let serving = match options.artifact_source.take() {
        Some(config) => Some(
            config
                .bind(&options.state_directory, &local_roots)
                .await?
                .serve(acquisitions.clone(), &token, &shutdown)
                .await?,
        ),
        None => None,
    };
    let coordination = CoordinationClients {
        acquisitions,
        artifact_source: serving.as_ref().map(|service| service.storage.clone()),
        artifact_peers: options.artifact_peers.clone(),
        transfers: checkpoints::Transfers::new(channel.clone(), headers.clone()),
        artifacts: ArtifactTransfersClient::with_interceptor(
            options
                .control_plane
                .clone()
                .timeout(Duration::from_secs(65))
                .connect_lazy(),
            headers.clone(),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES),
        workstreams: AttemptWorkstreamsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        mailbox: AttemptMailboxClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        work_sessions: AttemptWorkSessionsClient::with_interceptor(
            channel.clone(),
            headers.clone(),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES),
        mcp_effects: AttemptMcpEffectsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        changed_paths: AttemptChangedPathsClient::with_interceptor(
            channel.clone(),
            headers.clone(),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES),
        effects: AttemptEffectsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        workspace_mounts: AttemptWorkspaceMountsClient::with_interceptor(
            channel.clone(),
            headers.clone(),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES),
    };
    let transfers = checkpoints::Transfers::new(channel.clone(), headers.clone());
    let mut host = WorkerHostClient::with_interceptor(channel, headers)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    // Preflight: warn before claiming work when the host is short of disk space.
    if let Some(warning) = environment::low_disk_warning(options.disk_space.sample().as_ref()) {
        supertag_protocol::terminal_text::warn(&warning);
    }
    let keep_awake = environment::KeepAwake::start(options.keep_awake.clone(), shutdown.clone());
    let presence = match &options.lane {
        // A supervised lane's supervisor reports the Host's presence, disk space, and labels.
        Some(lane) => readiness::Reporter::lane(lane.observer.clone()),
        None => readiness::Reporter::Host(Box::new(readiness::Presence::start(
            journal.clone(),
            options.disk_space.clone(),
            host.clone(),
            token.clone(),
            options.harness as i32,
            workspaces
                .ids()
                .into_iter()
                .chain(workspaces.control_plane_ids())
                .collect(),
            (
                {
                    let profile = options.execution_profile.clone();
                    let catalog = options.mcp_catalog.clone();
                    Arc::new(move || McpCatalog::advertised(&profile, &catalog.lapsed_logins()))
                },
                labels,
            ),
            shutdown.clone(),
        ))),
    };
    let outcome = async {
    let mut ready = Some(ready);
    let retire = options.lane.as_ref().map(|lane| lane.retire.clone());
    while !shutdown.is_cancelled() {
        let entry = match journal.load()? {
            Some(entry) => entry,
            // A retired lane leaves before it records a new Claim.
            None if retire.as_ref().is_some_and(CancellationToken::is_cancelled) => {
                presence.set(readiness::State::Stopping);
                return Ok(());
            }
            None => {
                let operation_id = Uuid::new_v4().to_string();
                let claim = claim_request(&options, &workspaces, operation_id.clone());
                let entry = Entry::Claim {
                    operation_id,
                    request: claim.encode_to_vec(),
                };
                journal.save(&entry)?;
                entry
            }
        };
        let state = match &entry {
            Entry::Claim { .. } => readiness::State::Ready,
            Entry::Executing { .. } => readiness::State::Recovery,
            _ => readiness::State::Busy,
        };
        presence.set(state);
        keep_awake.update(state == readiness::State::Busy);
        match entry {
            Entry::Claim { operation_id, request: saved } => {
                if saved.is_empty() {
                    journal.clear()?;
                    continue;
                }
                let claim = ClaimTaskRequest::decode(saved.as_slice())
                    .context("stored Claim is invalid")?;
                ensure!(claim.operation_id == operation_id, "stored Claim identity differs");
                if claim != claim_request(&options, &workspaces, operation_id) {
                    // Never submit an unsent Claim with a superseded profile. A
                    // previously allocated reservation expires on its existing lease.
                    journal.clear()?;
                    continue;
                }
                supertag_protocol::crash_point("worker-host.claim", "journaled");
                presence.first_report(Duration::from_secs(5)).await;
                let response = host
                    .claim_task(request(claim, &token)?)
                    .await;
                let assignment = match response {
                    Ok(response) => response.into_inner().assignment,
                    Err(error) if retryable(&error) => {
                        wait_for_work(&shutdown).await;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                if let Some(ready) = ready.take() {
                    ready();
                }
                if let Some(assignment) = assignment {
                    supertag_protocol::crash_point("worker-host.claim", "assigned");
                    journal.save(&Entry::Starting {
                        attempt: Attempt::from_assignment(assignment)?,
                    })?;
                    supertag_protocol::crash_point("worker-host.start", "journaled");
                } else {
                    journal.clear()?;
                    if options.once {
                        return Ok(());
                    }
                    match &retire {
                        Some(retire) => tokio::select! {
                            () = wait_for_work(&shutdown) => {}
                            () = retire.cancelled() => {}
                        },
                        None => wait_for_work(&shutdown).await,
                    }
                }
            }
            Entry::Starting { attempt } | Entry::PreparingInputs { attempt, .. } => {
                run_assignment(
                    &options,
                    &journal,
                    &workspaces,
                    (&mut host, &inputs, &coordination, &transfers, &token, &registration),
                    attempt,
                    &shutdown,
                    || {
                        if let Some(ready) = ready.take() {
                            ready();
                        }
                    },
                )
                .await?;
            }
            Entry::Executing { attempt, prepared } => {
                ensure_providers_stopped(&options, &journal, &attempt, &registration)
                    .await
                    .context(cleanup_failure::CleanupUnconfirmed::default())?;
                match resolved(&mut host, &attempt, &token).await {
                    Ok(true) => journal.save(&Entry::Terminal { attempt, prepared })?,
                    Ok(false) if reclaim(&mut host, &journal, &attempt, &token).await? => {
                        supertag_protocol::terminal_text::warn(&format!(
                            "Task {} Attempt {} was interrupted; its processes stopped, so this host recorded it as failed with an unknown outcome",
                            attempt.task_id, attempt.attempt_id
                        ));
                        journal.save(&Entry::Terminal { attempt, prepared })?;
                    }
                    Ok(false) if options.wait_for_recovery => {
                        if let Some(ready) = ready.take() {
                            ready();
                            supertag_protocol::terminal_text::warn(&format!(
                                "Task {} Attempt {} needs recovery before this host can claim work",
                                attempt.task_id, attempt.attempt_id
                            ));
                        }
                        wait_for_work(&shutdown).await;
                    }
                    Ok(false) => {
                        return Err(anyhow::anyhow!(
                            "Task {} Attempt {} needs recovery before this host can claim work",
                            attempt.task_id,
                            attempt.attempt_id
                        )
                        .context(cleanup_failure::CleanupUnconfirmed::default()));
                    }
                    Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
                    Err(error) => return Err(error.into()),
                }
            }
            Entry::Finalizing {
                attempt,
                result,
                succeeded,
                objective_signal,
                waiting_approval_ids,
                checkpoint,
                workspace,
                remote_tree,
                outputs,
            } => {
                // This stage is recorded only after the adapter process group was reaped.
                // Exact finalization can safely resume after a Host restart.
                with_cleanup_authority(
                    &mut host, &attempt, &token, &shutdown,
                    ensure_providers_stopped(&options, &journal, &attempt, &registration),
                ).await?;
                if let Some(pending) = outputs.as_ref().filter(|output| succeeded && !output.frozen).cloned() {
                    if remote_tree.is_some() {
                        save_finish(&journal, attempt, adapter::failed("Task output files could not be captured safely"))?;
                        continue;
                    }
                    let cancellation = shutdown.child_token();
                    let frozen = with_authority(&mut host, &attempt, &token, &shutdown, &cancellation, async {
                        pending.freeze(&workspace, &workspaces, &options.state_directory, (&transfers, &attempt, &token), &cancellation)
                            .await.map(Box::new).map_err(|error| {
                                let required = supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING;
                                let message = if error.downcast_ref::<Status>().is_some_and(|status| status.message() == required) {
                                    required
                                } else {
                                    "Task output files could not be captured safely"
                                };
                                Status::failed_precondition(message)
                            })
                    }).await;
                    match frozen {
                        Ok((pending, _)) => journal.save(&Entry::Finalizing {
                            attempt,
                            result,
                            succeeded,
                            objective_signal,
                            waiting_approval_ids,
                            checkpoint,
                            workspace,
                            remote_tree,
                            outputs: Some(pending),
                        })?,
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
                        Err(error) => save_finish(
                            &journal,
                            attempt,
                            adapter::failed(
                                if error.message() == supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING {
                                    supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING
                                } else {
                                    "Task output files could not be captured safely"
                                },
                            ),
                        )?,
                    }
                    continue;
                }
                if succeeded && !options.workspace_mounts.is_empty() {
                    // Read-write copies are written back directly to their
                    // Volumes; the Control Plane records only the summary.
                    let cancellation = shutdown.child_token();
                    let mounts = options.workspace_mounts.clone();
                    let state = options.state_directory.clone();
                    let attempt_id = attempt.attempt_id.clone();
                    let copy_cancel = cancellation.clone();
                    let mut client = coordination.workspace_mounts.clone();
                    let reported = with_authority(&mut host, &attempt, &token, &shutdown, &cancellation, async {
                        let writes = tokio::task::spawn_blocking(move || {
                            workspace_mounts::write_back(&mounts, &state, &attempt_id, &copy_cancel)
                        })
                        .await
                        .map_err(|_| Status::internal("Workspace Volume write-back failed"))?
                        .map_err(|error| {
                            supertag_protocol::terminal_text::warn(&format!(
                                "Workspace Volume write-back failed: {error:#}"
                            ));
                            Status::failed_precondition("Workspace Volume write-back failed")
                        })?;
                        if writes.is_empty() {
                            return Ok(true);
                        }
                        let complete = writes
                            .iter()
                            .all(|write| write.status == WorkspaceMountWriteStatus::Complete as i32);
                        let report = RecordWorkspaceMountWritesRequest {
                            task_id: attempt.task_id.clone(),
                            attempt_id: attempt.attempt_id.clone(),
                            lease_token: attempt.lease_token.clone(),
                            writes,
                        };
                        client
                            .record_writes(request(report, &token).map_err(|_| Status::internal("Workspace Volume write-back failed"))?)
                            .await
                            .map(|_| complete)
                    })
                    .await;
                    match reported {
                        Ok((true, _)) => {}
                        // A partial or refused write-back fails the Task; its
                        // summary is recorded for `describe task`.
                        Ok((false, _)) => {
                            save_finish(&journal, attempt, adapter::failed("Workspace Volume write-back was partial or refused"))?;
                            continue;
                        }
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(error) if retryable(&error) => {
                            wait_for_work(&shutdown).await;
                            continue;
                        }
                        Err(_) => {
                            save_finish(&journal, attempt, adapter::failed("Workspace Volume write-back failed"))?;
                            continue;
                        }
                    }
                }
                let cancellation = shutdown.child_token();
                let finalization = with_authority(
                    &mut host,
                    &attempt,
                    &token,
                    &shutdown,
                    &cancellation,
                    async {
                        let input_state = options.state_directory.clone();
                        let input_attempt = attempt.attempt_id.clone();
                        let input_checkout = workspace.checkout.path.clone();
                        tokio::task::spawn_blocking(move || artifact_inputs::Inputs::cleanup(&input_state, &input_attempt, &input_checkout))
                            .await.map_err(|_| Status::internal("artifact input cleanup failed"))?
                            .map_err(|_| Status::failed_precondition("artifact input files could not be removed safely"))?;
                        if let Some(tree) = &remote_tree {
                            workspaces.restore_remote(&workspace, tree, &cancellation).await
                                .map_err(|_| Status::invalid_argument("Remote Workspace output could not be restored safely"))?;
                        }
                        if let Some(directory) = outputs.as_ref().and_then(|outputs| outputs.cleanup_directory()) {
                            let checkout = workspace.checkout.path.clone();
                            let directory = directory.to_owned();
                            tokio::task::spawn_blocking(move || {
                                supertag_workspaces::remove_output_directory(&checkout, &directory)
                                    .map_err(|_| Status::failed_precondition("Task output directory could not be removed safely"))
                            }).await.map_err(|_| Status::internal("Task output cleanup failed"))??;
                        }
                        workspaces
                            .finalize(&workspace, &result, succeeded, outputs.as_ref().map(|output| output.directory.as_str()), &cancellation)
                            .await
                            .map_err(|_| {
                                Status::invalid_argument(
                                    "Workspace output could not be captured safely",
                                )
                            })
                    },
                )
                .await;
                match finalization {
                    Ok((pending, _)) => journal.save(&Entry::Finish {
                        attempt,
                        result,
                        succeeded,
                        objective_signal,
                        waiting_approval_ids,
                        checkpoint,
                        workspace: Some(Box::new(pending)),
                        prepared: Some(workspace),
                        outputs,
                    })?,
                    Err(_) if shutdown.is_cancelled() => return Ok(()),
                    Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
                    Err(_) => save_finish(
                        &journal,
                        attempt,
                        adapter::failed("Workspace output could not be captured safely"),
                    )?,
                }
            }
            Entry::Finish {
                attempt,
                result,
                succeeded,
                objective_signal,
                waiting_approval_ids,
                checkpoint,
                workspace,
                prepared,
                outputs,
            } => {
                with_cleanup_authority(
                    &mut host, &attempt, &token, &shutdown,
                    ensure_providers_stopped(&options, &journal, &attempt, &registration),
                ).await?;
                let prepared = prepared.or_else(|| {
                    workspace.as_ref().map(|pending| {
                        Box::new(workspaces::PreparedWorkspace {
                            workspace_id: pending.workspace_id.clone(),
                            checkout: pending.checkout.clone(),
                        })
                    })
                });
                if let Some(mut pending) = workspace
                    .as_ref()
                    .filter(|pending| succeeded && !pending.uploaded)
                    .cloned()
                {
                    let receipt = match workspaces.verify(&pending) {
                        Ok(receipt) => receipt,
                        Err(_) => {
                            save_finish(
                                &journal,
                                attempt,
                                adapter::failed("Workspace output no longer matches its receipt"),
                            )?;
                            continue;
                        }
                    };
                    let cancellation = shutdown.child_token();
                    let upload = with_authority(
                        &mut host, &attempt, &token, &shutdown, &cancellation,
                        async {
                            tokio::select! {
                                result = transfers.upload_workspace(&attempt, &token, &pending, receipt) => result,
                                _ = cancellation.cancelled() => Err(Status::cancelled("workspace transfer cancelled")),
                            }
                        },
                    ).await;
                    match upload {
                        Ok(_) => {
                            pending.uploaded = true;
                            journal.save(&Entry::Finish {
                                attempt,
                                result,
                                succeeded,
                                objective_signal,
                                waiting_approval_ids,
                                checkpoint,
                                workspace: Some(pending),
                                prepared,
                                outputs,
                            })?;
                        }
                        Err(error)
                            if retryable(&error) || error.code() == Code::ResourceExhausted =>
                        {
                            wait_for_work(&shutdown).await
                        }
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(_) => save_finish(
                            &journal,
                            attempt,
                            adapter::failed("Workspace output could not be committed"),
                        )?,
                    }
                    continue;
                }
                if let Some(mut pending) = checkpoint
                    .as_ref()
                    .filter(|pending| !pending.uploaded)
                    .cloned()
                {
                    let upload =
                        async {
                            // Obtain a fresh budget after the adapter and its descendants stop.
                            host.renew_attempt(request(attempt.inspect(), &token).map_err(
                                |_| Status::internal("invalid upload authority request"),
                            )?)
                            .await?;
                            let payload = journal.read_checkpoint(&pending).map_err(|_| {
                                Status::data_loss("staged checkpoint could not be read")
                            })?;
                            transfers.upload(&attempt, &token, payload).await
                        }
                        .await;
                    match upload {
                        Ok(_) => {
                            pending.uploaded = true;
                            journal.save(&Entry::Finish {
                                attempt,
                                result,
                                succeeded,
                                objective_signal,
                                waiting_approval_ids,
                                checkpoint: Some(pending),
                                workspace,
                                prepared,
                                outputs,
                            })?;
                        }
                        Err(error)
                            if retryable(&error) || error.code() == Code::ResourceExhausted =>
                        {
                            wait_for_work(&shutdown).await;
                        }
                        Err(error)
                            if lost_ownership(&error)
                                || error.code() == Code::Unauthenticated
                                || error.code() == Code::InvalidArgument
                                || error.code() == Code::DataLoss =>
                        {
                            save_finish(
                                &journal,
                                attempt,
                                adapter::failed("Session checkpoint could not be committed"),
                            )?;
                        }
                        Err(error) => return Err(error.into()),
                    }
                    continue;
                }
                if let Some(mut pending) = outputs.as_ref().filter(|output| succeeded && output.pending()).cloned() {
                    let cancellation = shutdown.child_token();
                    let upload = with_authority(&mut host, &attempt, &token, &shutdown, &cancellation, async {
                        tokio::select! {
                            result = pending.publish(&options.state_directory, &attempt, &coordination, &token) => result,
                            _ = cancellation.cancelled() => Err(Status::cancelled("Task output transfer cancelled")),
                        }
                    }).await;
                    match upload {
                        Ok(_) => journal.save(&Entry::Finish {
                            attempt,
                            result,
                            succeeded,
                            objective_signal,
                            waiting_approval_ids,
                            checkpoint,
                            workspace,
                            prepared,
                            outputs: Some(pending),
                        })?,
                        Err(error) if retryable(&error) || error.code() == Code::ResourceExhausted => wait_for_work(&shutdown).await,
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(_) => save_finish(
                            &journal,
                            attempt,
                            adapter::failed("Task output could not be committed"),
                        )?,
                    }
                    continue;
                }
                supertag_protocol::crash_point("worker-host.finish", "journaled");
                let outcome = host
                    .finish_task(request(
                        FinishTaskRequest {
                            task_id: attempt.task_id.clone(),
                            attempt_id: attempt.attempt_id.clone(),
                            lease_token: attempt.lease_token.clone(),
                            result,
                            succeeded,
                            objective_signal,
                            waiting_approval_ids: waiting_approval_ids.clone(),
                            artifacts: outputs.as_ref().filter(|_| succeeded)
                                .and_then(|outputs| outputs.selection()).into_iter().collect(),
                            checkpoint_sha256: checkpoint.map(|pending| pending.sha256),
                            workspace_delivery: workspace
                                .as_ref()
                                .filter(|_| succeeded)
                                .map(|pending| workspaces.verify(pending))
                                .transpose()?,
                        },
                        &token,
                    )?)
                    .await;
                match outcome {
                    Ok(response) if response.get_ref().state() == TaskState::Uncertain => {
                        // Cleanup was observed, but the operator still owns the
                        // recovery decision. Preserve the checkout until its receipt.
                        // This host holds an outcome, so it never reclaims the Attempt itself.
                        journal.processes(&attempt).discard()?;
                        if prepared.is_some() {
                            journal.save(&Entry::Executing { attempt, prepared })?;
                            if options.once {
                                return Ok(());
                            }
                        } else {
                            journal.save(&Entry::Terminal {
                                attempt,
                                prepared: None,
                            })?;
                        }
                        continue;
                    }
                    Ok(response) => {
                        ensure!(
                            matches!(
                                response.get_ref().state(),
                                TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled
                            ),
                            "Finish returned a nonterminal Task"
                        );
                        supertag_protocol::crash_point("worker-host.finish", "answered");
                    }
                    Err(error) if retryable(&error) => {
                        wait_for_work(&shutdown).await;
                        continue;
                    }
                    Err(error)
                        if error.code() == Code::InvalidArgument
                            && (objective_signal != 0 || !waiting_approval_ids.is_empty()) =>
                    {
                        // An invalid owner signal is rejected before the Finish transaction
                        // commits. Settle the cleaned-up Attempt as a controlled failure.
                        journal.save(&Entry::Finish {
                            attempt,
                            result: "Harness proposed an invalid Objective or approval update".into(),
                            succeeded: false,
                            objective_signal: 0,
                            waiting_approval_ids: vec![],
                            checkpoint: None,
                            workspace,
                            prepared,
                            outputs: None,
                        })?;
                        continue;
                    }
                    Err(error) if lost_ownership(&error) || error.code() == Code::AlreadyExists => {
                        match resolved(&mut host, &attempt, &token).await {
                            Ok(true) => {}
                            Ok(false) => return Err(error.into()),
                            Err(error) if retryable(&error) => {
                                wait_for_work(&shutdown).await;
                                continue;
                            }
                            Err(error) => return Err(error.into()),
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
                journal.save(&Entry::Terminal { attempt, prepared })?;
            }
            Entry::Terminal { attempt, prepared } => {
                cleanup_terminal(&journal, &workspaces, &options.state_directory, &attempt, prepared.as_deref())?;
                if let Some(ready) = ready.take() {
                    ready();
                }
                if options.once {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
    }.await;
    keep_awake.stop().await;
    if let Err(error) = &outcome
        && error
            .downcast_ref::<cleanup_failure::CleanupUnconfirmed>()
            .is_some()
        && let Ok(Some(entry)) = journal.load()
        && let Some(attempt) = entry.unsettled_attempt()
    {
        cleanup_failure::report(&mut host, attempt, &token, error).await;
    }
    let stopped = presence.stop().await;
    outcome.and(stopped)
}

fn cleanup_terminal(
    journal: &Journal,
    workspaces: &workspaces::Workspaces,
    state_directory: &std::path::Path,
    attempt: &Attempt,
    prepared: Option<&workspaces::PreparedWorkspace>,
) -> Result<()> {
    workspace_mounts::cleanup(state_directory, &attempt.attempt_id)?;
    if let Some(prepared) = prepared {
        workspaces.discard(prepared)?;
    }
    context::discard_attempt(state_directory, &attempt.attempt_id)?;
    journal.clear()
}

fn discard_prelaunch(
    options: &HostOptions,
    journal: &Journal,
    workspaces: &workspaces::Workspaces,
    attempt: &Attempt,
) -> Result<()> {
    let prepared = journal
        .load()?
        .map(|entry| entry.prepared(attempt))
        .transpose()?
        .flatten();
    cleanup_terminal(
        journal,
        workspaces,
        &options.state_directory,
        attempt,
        prepared.as_deref(),
    )
}

async fn resolved(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
) -> Result<bool, Status> {
    let mut request = authenticated_request(attempt.inspect(), token, None)?;
    request.set_timeout(Duration::from_secs(5));
    let receipt = host
        .get_attempt_resolution(request)
        .await?
        .into_inner()
        .resolution;
    match receipt {
        Some(receipt)
            if receipt.task_id == attempt.task_id && receipt.attempt_id == attempt.attempt_id =>
        {
            Ok(true)
        }
        Some(_) => Err(Status::data_loss(
            "recovery receipt has mismatched identity",
        )),
        None => Ok(false),
    }
}

/// Reclaims an interrupted Attempt when its process record proves every process it started is
/// gone, as TypeScript's automatic reclaim does. Returns whether the Control Plane recorded it;
/// without proof, or when the Control Plane refuses, the Attempt waits for an operator.
async fn reclaim(
    host: &mut RegisteredHost,
    journal: &Journal,
    attempt: &Attempt,
    token: &str,
) -> Result<bool> {
    let Some(evidence) = journal.processes(attempt).stopped()? else {
        return Ok(false);
    };
    let mut request = request(
        ReclaimAttemptRequest {
            attempt: Some(attempt.inspect()),
            evidence,
        },
        token,
    )?;
    request.set_timeout(Duration::from_secs(5));
    match host.reclaim_attempt(request).await {
        Ok(response) => {
            let resolution = response.into_inner();
            ensure!(
                resolution.task_id == attempt.task_id
                    && resolution.attempt_id == attempt.attempt_id,
                "recovery receipt has mismatched identity"
            );
            Ok(true)
        }
        Err(error) if retryable(&error) => Ok(false),
        Err(error)
            if matches!(
                error.code(),
                tonic::Code::FailedPrecondition | tonic::Code::AlreadyExists | tonic::Code::Aborted
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}

async fn run_assignment(
    options: &HostOptions,
    journal: &Journal,
    workspaces: &workspaces::Workspaces,
    connection: (
        &mut RegisteredHost,
        &RegisteredInputs,
        &CoordinationClients,
        &checkpoints::Transfers,
        &str,
        &HostRecord,
    ),
    attempt: Attempt,
    shutdown: &CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    let (host, inputs, coordination, transfers, token, registration) = connection;
    // Starting is durable before requesting authority and never records a launch.
    // A lost start response can therefore be retried using this exact Attempt.
    let can_launch = attempt.can_launch(options)?;
    let start = if can_launch {
        host.start_task(request(
            StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
            token,
        )?)
        .await
    } else {
        host.inspect_attempt(request(attempt.inspect(), token)?)
            .await
    };
    let task = match start {
        Ok(response) => {
            if can_launch {
                supertag_protocol::crash_point("worker-host.start", "answered");
            }
            response.into_inner()
        }
        Err(error) if retryable(&error) => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Err(error) if lost_ownership(&error) => {
            match host
                .inspect_attempt(request(attempt.inspect(), token)?)
                .await
            {
                Ok(response) => response.into_inner(),
                Err(error) if retryable(&error) => {
                    wait_for_work(shutdown).await;
                    return Ok(());
                }
                // No adapter was launched for Starting. The Control Plane can
                // safely retire a reservation that expired before start.
                Err(error) if lost_ownership(&error) => {
                    return discard_prelaunch(options, journal, workspaces, &attempt);
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    };
    ensure_attempt(&task, &attempt)?;
    if !can_launch {
        ready();
        if task.state() == TaskState::Claimed {
            // Starting never launched an adapter. Leave an unstarted reservation
            // for the Control Plane's lease expiry to put back in the queue.
            return journal.clear();
        }
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host execution profile changed before launch"),
        );
    }
    if task.state() == TaskState::Claimed {
        // A pause can block Start after Claim. No adapter has launched, so
        // retain the intent while the Control Plane retires the reservation.
        ready();
        wait_for_work(shutdown).await;
        return Ok(());
    }
    if matches!(task.state(), TaskState::Cancelled | TaskState::Uncertain) {
        ready();
        return save_finish(
            journal,
            attempt,
            adapter::failed("Task Attempt ended before launch"),
        );
    }
    ensure!(
        task.state() == TaskState::Running,
        "Control Plane did not authorize the Task Attempt to start"
    );

    let sent = Instant::now();
    let renewed = host.renew_attempt(request(attempt.inspect(), token)?).await;
    let authority = match renewed {
        Ok(response) => response.into_inner(),
        Err(error) if retryable(&error) => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Err(error) if lost_ownership(&error) => {
            return discard_prelaunch(options, journal, workspaces, &attempt);
        }
        Err(error) => return Err(error.into()),
    };
    ready();
    let mut task = authority.task.context("execution authority has no Task")?;
    ensure_attempt(&task, &attempt)?;
    if let Some(workspace) = task
        .workspace
        .as_ref()
        .filter(|spec| !spec.base_ref.is_empty() && spec.base_commit.is_empty())
    {
        // A Tag that follows a branch: this Session's first Attempt resolves it here, and the
        // Control Plane records the first resolution for every Task of the Session.
        let branch = workspace.base_ref.clone();
        let Ok(commit) = workspaces
            .resolve_ref(&workspace.workspace_id, &branch, shutdown)
            .await
        else {
            return save_finish(
                journal,
                attempt,
                adapter::failed(&format!(
                    "Workspace branch {branch} does not name a commit on this Worker Host"
                )),
            );
        };
        match host
            .resolve_workspace_ref(request(
                ResolveWorkspaceRefRequest {
                    attempt: Some(attempt.inspect()),
                    base_commit: commit,
                },
                token,
            )?)
            .await
        {
            Ok(response) => {
                task = response.into_inner();
                ensure_attempt(&task, &attempt)?;
            }
            Err(error) if retryable(&error) => {
                wait_for_work(shutdown).await;
                return Ok(());
            }
            Err(error) if lost_ownership(&error) => {
                return discard_prelaunch(options, journal, workspaces, &attempt);
            }
            Err(error) => return Err(error.into()),
        }
    }
    let valid_until = sent
        .checked_add(Duration::from_millis(authority.valid_for_ms))
        .context("invalid execution authority duration")?;
    if task.state() != TaskState::Running || valid_until <= Instant::now() {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Execution authority expired before launch"),
        );
    }
    if !supertag_protocol::mcp::supports(&task, options.harness, &options.execution_profile) {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host cannot enforce accepted MCP grants"),
        );
    }
    if !supertag_protocol::shared_execution::supports(
        &task,
        options.harness,
        options.execution_profile.shared_execution.as_ref(),
    ) {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host cannot enforce accepted shared execution placement"),
        );
    }
    if !supertag_protocol::output_policy::supports(
        &task,
        options.harness,
        &options.execution_profile,
    ) {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host cannot enforce accepted Task output requirements"),
        );
    }
    if !supertag_protocol::task_artifact_inputs::supports(
        &task,
        options.harness,
        &options.execution_profile,
    ) || (!task.input_artifacts.is_empty()
        && !task
            .attempt_execution
            .as_ref()
            .is_some_and(|execution| execution.task_artifact_inputs))
    {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host cannot materialize accepted Task artifact inputs"),
        );
    }
    let mount_pins = task
        .workspace
        .as_ref()
        .map(|workspace| workspace.mounts.clone())
        .unwrap_or_default();
    if !mount_pins.is_empty() {
        let check = match coordination
            .workspace_mounts
            .clone()
            .preflight(request(attempt.inspect(), token)?)
            .await
        {
            Err(error) if retryable(&error) => {
                wait_for_work(shutdown).await;
                return Ok(());
            }
            check => check,
        };
        let permitted = supertag_protocol::workspace_mounts::supports(
            &task,
            options.harness,
            &options.execution_profile,
        ) && check.ok().is_some_and(|response| {
            options
                .workspace_mounts
                .preflight(&mount_pins, response.into_inner())
                .is_ok()
        });
        if !permitted {
            return save_finish(
                journal,
                attempt,
                adapter::failed("Workspace Volume path admission failed"),
            );
        }
    }
    let checkpoint = match time::timeout_at(valid_until, transfers.download(&attempt, token)).await
    {
        Ok(Ok(checkpoint)) => checkpoint,
        Ok(Err(error)) if retryable(&error) || error.code() == Code::ResourceExhausted => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Ok(Err(error)) if lost_ownership(&error) || error.code() == Code::DataLoss => {
            return save_finish(
                journal,
                attempt,
                adapter::failed("Session checkpoint could not be restored"),
            );
        }
        Ok(Err(error)) => return Err(error.into()),
        Err(_) => {
            return save_finish(
                journal,
                attempt,
                adapter::failed("Execution authority expired during checkpoint transfer"),
            );
        }
    };
    let resolved_skills = if task.policy_snapshot.as_ref().is_some_and(|snapshot| {
        snapshot
            .context_sets
            .iter()
            .any(|set| !set.items.is_empty())
    }) {
        let cancel = shutdown.child_token();
        let context_host = host.clone();
        match with_authority(
            host,
            &attempt,
            token,
            shutdown,
            &cancel,
            prepare_context(options, &task, &attempt, context_host, token, &cancel),
        )
        .await
        {
            Ok((skills, _)) => skills,
            Err(error) if retryable(&error) && !shutdown.is_cancelled() => {
                wait_for_work(shutdown).await;
                return Ok(());
            }
            Err(_) => {
                return save_finish(
                    journal,
                    attempt,
                    adapter::failed("Task Context Items could not be resolved safely"),
                );
            }
        }
    } else {
        vec![]
    };
    let operation_cancel = shutdown.child_token();
    let prepared = with_authority(host, &attempt, token, shutdown, &operation_cancel, async {
        workspaces
            .prepare(&task, &attempt, transfers, token, &operation_cancel)
            .await
            .map_err(|error| {
                error.downcast::<Status>().unwrap_or_else(|_| {
                    Status::invalid_argument("Task workspace could not be prepared safely")
                })
            })
    })
    .await;
    let (workspace, mut valid_until) = match prepared {
        Ok(prepared) => prepared,
        Err(error) if retryable(&error) && !shutdown.is_cancelled() => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Err(error) => {
            // A failed setup names itself and keeps its untrusted output, as TypeScript's
            // `workspace-setup` failure does.
            let message = if error.message().starts_with("Workspace setup") {
                error.message()
            } else {
                "Task workspace could not be prepared safely"
            };
            return save_finish(journal, attempt, adapter::failed(message));
        }
    };
    if !task.input_artifacts.is_empty() && options.remote_provider.is_none() {
        let prepared = workspace
            .as_ref()
            .context("Task artifact input Workspace is missing")?;
        journal.save(&Entry::PreparingInputs {
            attempt: attempt.clone(),
            prepared: Box::new(prepared.clone()),
        })?;
        let cancel = shutdown.child_token();
        let staged = Box::pin(with_authority(
            host,
            &attempt,
            token,
            shutdown,
            &cancel,
            task_artifact_inputs::prepare(
                (&options.state_directory, &prepared.checkout.path),
                &task,
                &attempt,
                coordination,
                token,
                &cancel,
            ),
        ))
        .await;
        match staged {
            Ok((instructions, expires)) => {
                task.instructions.push_str(&instructions);
                valid_until = expires;
            }
            Err(_) if shutdown.is_cancelled() => return Ok(()),
            Err(error) if retryable(&error) => {
                wait_for_work(shutdown).await;
                return Ok(());
            }
            Err(_) => {
                return save_finish(
                    journal,
                    attempt,
                    adapter::failed("Task artifact inputs could not be materialized safely"),
                );
            }
        }
    }
    let mounted = if mount_pins.is_empty() {
        None
    } else {
        let checkout = workspace
            .as_ref()
            .context("Workspace mount checkout is missing")?;
        journal.save(&Entry::PreparingInputs {
            attempt: attempt.clone(),
            prepared: Box::new(checkout.clone()),
        })?;
        let state = options.state_directory.clone();
        let checkout = checkout.checkout.path.clone();
        let attempt_id = attempt.attempt_id.clone();
        let mappings = options.workspace_mounts.clone();
        let cancel = shutdown.child_token();
        let copy_cancel = cancel.clone();
        let operation = async {
            let current = coordination
                .workspace_mounts
                .clone()
                .preflight(
                    request(attempt.inspect(), token)
                        .map_err(|_| Status::internal("Workspace Volume request failed"))?,
                )
                .await?
                .into_inner();
            let protected = mappings.preflight(&mount_pins, current).map_err(|_| {
                Status::failed_precondition("Workspace Volume path admission failed")
            })?;
            tokio::task::spawn_blocking(move || {
                mappings.stage(
                    &state,
                    &attempt_id,
                    &checkout,
                    &mount_pins,
                    &protected,
                    &copy_cancel,
                )
            })
            .await
            .map_err(|_| Status::internal("Workspace Volume staging failed"))?
            .map_err(|error| {
                supertag_protocol::terminal_text::warn(&format!(
                    "Workspace Volume staging failed: {error:#}"
                ));
                Status::failed_precondition("Workspace Volume staging failed")
            })
        };
        match Box::pin(with_authority(
            host, &attempt, token, shutdown, &cancel, operation,
        ))
        .await
        {
            Ok((mounted, expires)) => {
                // A remote Workspace names its copies where the sandbox holds them.
                if options.remote_provider.is_none() {
                    task.instructions.push_str(&mounted.instructions()?);
                }
                valid_until = expires;
                Some(mounted)
            }
            Err(_) if shutdown.is_cancelled() => return Ok(()),
            Err(_) => {
                return save_finish(
                    journal,
                    attempt,
                    adapter::failed("Workspace Volume staging failed"),
                );
            }
        }
    };
    let processes = journal.processes(&attempt);
    processes.begin(options.remote_provider.is_none() && options.shared_execution.is_none())?;
    journal.save(&Entry::Executing {
        attempt: attempt.clone(),
        prepared: workspace
            .as_ref()
            .map(|prepared| Box::new(prepared.clone())),
    })?;
    supertag_protocol::crash_point("worker-host.execute", "journaled");
    let workspace_mcp = if supertag_protocol::mcp::workspace_servers(&task).is_empty() {
        None
    } else {
        let cancel = shutdown.child_token();
        let resolved = with_authority(
            host,
            &attempt,
            token,
            shutdown,
            &cancel,
            workspace_mcp(
                workspaces,
                (
                    workspace.as_ref(),
                    options.remote_provider.as_ref().map(ProviderConfig::label),
                ),
                &task,
                (&coordination.mcp_effects, &attempt, token),
                &cancel,
            ),
        )
        .await;
        match resolved {
            Ok((resolved, expires)) => {
                valid_until = expires;
                Some(resolved)
            }
            Err(error) => {
                if let Some(prepared) = workspace.as_ref() {
                    workspaces.remove_mcp_snapshot(prepared);
                }
                let message = if error.code() == Code::InvalidArgument
                    || error.code() == Code::FailedPrecondition
                {
                    error.message().to_owned()
                } else {
                    "Workspace MCP servers could not be resolved safely".into()
                };
                return save_finish(journal, attempt, adapter::failed(&message));
            }
        }
    };
    let pending_outputs = if let Some(workspace) = workspace
        .as_ref()
        .filter(|_| options.remote_provider.is_some())
    {
        task_outputs::PendingOutputs::prepare_remote(&task, workspace, &attempt)
    } else {
        task_outputs::PendingOutputs::prepare(
            &task,
            workspace
                .as_ref()
                .map(|workspace| workspace.checkout.path.as_path()),
            &attempt,
            options.harness,
        )
    };
    let mut outputs = match pending_outputs {
        Ok(outputs) => outputs.map(Box::new),
        Err(_) => {
            return save_finish(
                journal,
                attempt,
                adapter::failed("Task output directory could not be prepared safely"),
            );
        }
    };
    let mut sandbox_execution_ends = None;
    let mut provider = if options.remote_provider.is_some() {
        let workspace = workspace
            .as_ref()
            .context("remote Attempt has no prepared Workspace")?;
        let cancel = shutdown.child_token();
        let prepared = Box::pin(with_authority(
            host,
            &attempt,
            token,
            shutdown,
            &cancel,
            async {
                // The base commit's devcontainer subset is read and refused here, before any
                // provider call. A refusal names the property; nothing else reaches the Task.
                let environment = workspaces
                    .remote_environment(workspace, &cancel)
                    .await
                    .map_err(|error| {
                        Status::invalid_argument(format!("{DEVCONTAINER_REFUSAL}{error:#}"))
                    })?;
                remote::prepare(
                    options,
                    journal,
                    workspaces,
                    (&attempt, workspace, &task),
                    (
                        // Only a sandboxed stdio server needs the trusted copy beside the checkout.
                        workspace_mcp
                            .as_ref()
                            .filter(|resolved| resolved.sandboxed())
                            .map(|_| workspace.checkout.base_commit.as_str()),
                        environment,
                        mounted.as_ref(),
                    ),
                    (registration, coordination, token),
                    &cancel,
                )
                .await
                .map_err(|_| Status::failed_precondition("Remote Workspace could not be prepared"))
            },
        ))
        .await;
        match prepared {
            Ok(((provider, instructions, execution_ends), expires)) => {
                if let Some(instructions) = instructions {
                    task.instructions.push_str(&instructions);
                }
                valid_until = expires;
                sandbox_execution_ends = Some(execution_ends);
                Some(provider)
            }
            Err(error) => {
                with_cleanup_authority(
                    host,
                    &attempt,
                    token,
                    shutdown,
                    remote::ensure_stopped(options, journal, &attempt, registration),
                )
                .await?;
                let message = if error.message().starts_with(DEVCONTAINER_REFUSAL) {
                    error.message()
                } else {
                    "Remote Workspace could not be prepared"
                };
                return save_finish(journal, attempt, adapter::failed(message));
            }
        }
    } else {
        None
    };
    // A remote Workspace's stdio servers run in its staged sandbox, so they start after it.
    let sandbox = provider
        .as_ref()
        .map(remote_provider::RemoteProvider::mcp_connection);
    let mcp = if supertag_protocol::mcp::grants(&task).next().is_some() {
        let cancel = shutdown.child_token();
        match with_authority(
            host,
            &attempt,
            token,
            shutdown,
            &cancel,
            mcp::AttemptMcp::prepare(
                &options.mcp_catalog,
                (workspace_mcp.as_ref(), sandbox.as_ref()),
                &task,
                &processes,
                &cancel,
            ),
        )
        .await
        {
            Ok((mcp, expires)) => {
                valid_until = expires;
                mcp.map(Arc::new)
            }
            Err(_) => {
                if let Some(prepared) = workspace.as_ref().filter(|_| workspace_mcp.is_some()) {
                    workspaces.remove_mcp_snapshot(prepared);
                }
                if let Some(provider) = provider.as_mut() {
                    with_cleanup_authority(host, &attempt, token, shutdown, async {
                        let closed = provider.shutdown().await;
                        remote::ensure_stopped(options, journal, &attempt, registration).await?;
                        closed
                    })
                    .await?;
                }
                // A login that lapsed since this host claimed the Task names its command.
                let lapsed = options.mcp_catalog.lapsed_logins();
                let message = supertag_protocol::mcp::grants(&task)
                    .filter_map(|(_, grant)| supertag_protocol::mcp::parse_action(&grant.action))
                    .find(|(server, _)| lapsed.iter().any(|name| name == server))
                    .map_or_else(
                        || "Task MCP tools could not be resolved safely".to_owned(),
                        |(server, _)| {
                            format!(
                                "MCP server {server}: its login lapsed on this Worker Host; run {} there to log in again",
                                mcp::login_command(server)
                            )
                        },
                    );
                return save_finish(journal, attempt, adapter::failed(&message));
            }
        }
    } else {
        None
    };
    let shared_access = if let Some(config) = options.shared_execution.as_ref() {
        let cancel = shutdown.child_token();
        match with_authority(host, &attempt, token, shutdown, &cancel, async {
            shared_execution::prepare(
                config,
                journal,
                &attempt,
                &task,
                registration,
                options.attempt_timeout,
            )
            .await
            .map_err(|_| {
                Status::failed_precondition("shared execution access could not be prepared")
            })
        })
        .await
        {
            Ok((access, expires)) => {
                valid_until = expires;
                Some(access)
            }
            Err(_) => {
                save_finish(
                    journal,
                    attempt.clone(),
                    adapter::failed("Shared execution access could not be prepared safely"),
                )?;
                with_cleanup_authority(
                    host,
                    &attempt,
                    token,
                    shutdown,
                    shared_execution::ensure_released(options, journal, &attempt, registration),
                )
                .await?;
                return Ok(());
            }
        }
    } else {
        None
    };
    let uses_shared_access = shared_access.is_some();
    let remote_workspace = provider
        .as_ref()
        .map(|provider| {
            let (channel, token) = provider.workspace_connection();
            adapter::RemoteWorkspace::new(channel, token)
        })
        .or_else(|| shared_access.map(adapter::RemoteWorkspace::shared));
    let adapter_workspace = workspace
        .as_ref()
        .filter(|_| remote_workspace.is_none())
        .map(|prepared| prepared.checkout.path.as_path());
    let output_directory = outputs
        .as_ref()
        .zip(adapter_workspace)
        .map(|(outputs, checkout)| outputs.absolute(checkout));
    if let Some(output) = outputs.as_ref().filter(|_| provider.is_some()) {
        task.instructions.push_str(&format!(
            "\n\nTask output directory: {}\nUse paths relative to the remote Workspace in the admitted file tools. SuperTag preserves selected Task outputs from this Attempt.",
            output.directory,
        ));
        if let Some(policy) = &task.output_policy {
            task.instructions.push_str(&format!(
                "\nRequired output paths and patterns, relative to the Workspace: {}.",
                serde_json::to_string(&policy.required)?,
            ));
        }
    } else if let Some(directory) = &output_directory
        && task
            .allowed_actions
            .iter()
            .any(|action| action == "files:write")
    {
        task.instructions.push_str(&format!(
            "\n\nSave deliverables in the Task output directory at {}. Use this directory for files you want to return with the Task result.",
            directory.display(),
        ));
    }
    let has_inputs = !task.input_artifacts.is_empty();
    // Overlap warnings compare the changed paths of local checkouts only.
    let stop_reports = shutdown.child_token();
    let reports = workspace
        .as_ref()
        .filter(|_| adapter_workspace.is_some())
        .map(|prepared| {
            tokio::spawn(changed_paths::report(
                coordination.changed_paths.clone(),
                attempt.inspect(),
                token.to_owned(),
                prepared.checkout.clone(),
                stop_reports.clone(),
            ))
        });
    let assignment = Assignment {
        task: Some(task),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
    };
    let outcome = adapter::execute(
        options,
        assignment,
        adapter::ExecutionInputs {
            checkpoint,
            workspace: adapter_workspace,
            output_directory: output_directory.as_deref(),
            resolved_skills,
            remote_workspace,
            mcp: mcp.clone(),
            processes: processes.clone(),
            sandbox_execution_ends,
        },
        (host.clone(), inputs.clone(), coordination.clone()),
        token,
        valid_until,
        shutdown,
    )
    .await
    // The adapter run's errors carry its cleanup marker and the Attempt's values to redact.
    .with_context(|| {
        format!(
            "Task {} Attempt {} needs recovery",
            attempt.task_id, attempt.attempt_id
        )
    });
    stop_reports.cancel();
    if let Some(reports) = reports {
        let _ = reports.await;
    }
    if let Some(mcp) = mcp {
        mcp.close().await;
    }
    if let Some(prepared) = workspace.as_ref().filter(|_| workspace_mcp.is_some()) {
        workspaces.remove_mcp_snapshot(prepared);
    }
    let saved = async {
        let mut outcome = outcome?;
        let remote_tree = if let Some(provider) = provider.as_ref().filter(|_| outcome.succeeded) {
            let cancel = shutdown.child_token();
            let workspace = workspace.as_ref().expect("remote Workspace prepared");
            let captured = with_authority(
                host,
                &attempt,
                token,
                shutdown,
                &cancel,
                remote::capture(
                    provider,
                    journal,
                    (workspace, workspaces, has_inputs),
                    outputs.take(),
                    (
                        &options.state_directory,
                        mounted
                            .as_ref()
                            .map(|mounted| (mounted, &options.workspace_mounts)),
                    ),
                    (transfers, &attempt, token),
                    &cancel,
                ),
            )
            .await;
            match captured {
                Ok(((tree, frozen), _)) => {
                    outputs = frozen;
                    Some(tree)
                }
                Err(error) => {
                    let message = match error.message() {
                        supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING => {
                            supertag_protocol::output_policy::REQUIRED_OUTPUT_MISSING
                        }
                        remote::OUTPUTS_FAILED => remote::OUTPUTS_FAILED,
                        remote::COPY_CAPTURE_FAILED => remote::COPY_CAPTURE_FAILED,
                        _ => remote::CAPTURE_FAILED,
                    };
                    outcome = adapter::failed(message);
                    None
                }
            }
        } else {
            None
        };
        if let Some(workspace) = workspace {
            let checkpoint = outcome
                .checkpoint
                .map(|checkpoint| journal.stage_checkpoint(checkpoint))
                .transpose()?;
            journal.save(&Entry::Finalizing {
                attempt: attempt.clone(),
                result: outcome.result,
                succeeded: outcome.succeeded,
                objective_signal: outcome.objective_signal,
                waiting_approval_ids: outcome.waiting_approval_ids,
                checkpoint,
                workspace: Box::new(workspace),
                remote_tree,
                outputs,
            })
        } else {
            save_finish(journal, attempt.clone(), outcome)
        }
    }
    .await;
    if uses_shared_access {
        with_cleanup_authority(
            host,
            &attempt,
            token,
            shutdown,
            shared_execution::ensure_released(options, journal, &attempt, registration),
        )
        .await?;
    }
    if let Some(provider) = provider.as_mut() {
        with_cleanup_authority(host, &attempt, token, shutdown, async {
            let closed = provider.shutdown().await;
            remote::ensure_stopped(options, journal, &attempt, registration).await?;
            closed
        })
        .await?;
    }
    saved
}

/// Snapshots the Task's base commit, resolves its Workspace MCP servers there, and records
/// them with the Control Plane before any of them starts. A digest that differs from the one the
/// Task's first Attempt recorded is refused, so nothing starts.
async fn workspace_mcp(
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
        .map_err(|_| Status::internal("Workspace MCP snapshot failed"))?;
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
            .map_err(|_| Status::internal("Workspace MCP record request failed"))?,
        )
        .await?;
    Ok(resolved)
}

async fn prepare_context(
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
        .map_err(|_| Status::failed_precondition("Context Item could not be prepared"))?;
    let manifest = prepared
        .manifest()
        .map_err(|_| Status::data_loss("invalid prepared Context Items"))?;
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
    prepared
        .delivery()
        .map_err(|_| Status::data_loss("invalid Context Item delivery"))
}

fn ensure_attempt(task: &Task, attempt: &Attempt) -> Result<()> {
    ensure!(
        task.task_id == attempt.task_id
            && task.attempt_id.as_deref() == Some(attempt.attempt_id.as_str()),
        "Control Plane returned a different Task Attempt"
    );
    ensure!(
        task.attempt_execution.as_ref().map(Message::encode_to_vec) == attempt.execution_selection,
        "Control Plane returned a different Attempt execution selection"
    );
    Ok(())
}

fn save_finish(journal: &Journal, attempt: Attempt, outcome: HarnessCompleteRequest) -> Result<()> {
    let prepared = journal
        .load()?
        .map(|entry| entry.prepared(&attempt))
        .transpose()?
        .flatten();
    let checkpoint = outcome
        .checkpoint
        .map(|checkpoint| journal.stage_checkpoint(checkpoint))
        .transpose()?;
    journal.save(&Entry::Finish {
        attempt,
        result: outcome.result,
        succeeded: outcome.succeeded,
        objective_signal: outcome.objective_signal,
        waiting_approval_ids: outcome.waiting_approval_ids,
        checkpoint,
        workspace: None,
        prepared,
        outputs: None,
    })
}

async fn renew_running_attempt(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
) -> Result<Instant, Status> {
    let sent = Instant::now();
    let response = host
        .renew_attempt(
            request(attempt.inspect(), token)
                .map_err(|_| Status::internal("invalid authority request"))?,
        )
        .await?
        .into_inner();
    let task = response
        .task
        .as_ref()
        .ok_or_else(|| Status::data_loss("execution authority has no Task"))?;
    ensure_attempt(task, attempt)
        .map_err(|_| Status::data_loss("execution authority has mismatched identity"))?;
    if task.state() != TaskState::Running {
        return Err(Status::failed_precondition("execution authority ended"));
    }
    let until = sent
        .checked_add(Duration::from_millis(response.valid_for_ms))
        .ok_or_else(|| Status::data_loss("invalid authority duration"))?;
    if until <= Instant::now() {
        return Err(Status::failed_precondition("execution authority expired"));
    }
    Ok(until)
}

async fn ensure_providers_stopped(
    options: &HostOptions,
    journal: &Journal,
    attempt: &Attempt,
    registration: &HostRecord,
) -> Result<()> {
    remote::ensure_stopped(options, journal, attempt, registration).await?;
    shared_execution::ensure_released(options, journal, attempt, registration).await
}

/// Cleanup continues after authority ends. Only renewal stops on cancellation.
async fn with_cleanup_authority(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    shutdown: &CancellationToken,
    cleanup: impl std::future::Future<Output = Result<()>>,
) -> Result<()> {
    let keep_lease = async {
        let mut pulse = time::interval(Duration::from_secs(2));
        pulse.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                _ = pulse.tick() => {},
            }
            match renew_running_attempt(host, attempt, token).await {
                Ok(_) => {}
                Err(error) if retryable(&error) => {}
                Err(_) => break,
            }
        }
    };
    tokio::pin!(cleanup);
    let result = tokio::select! {
        biased;
        result = &mut cleanup => result,
        () = keep_lease => cleanup.await,
    };
    result.context(cleanup_failure::CleanupUnconfirmed::default())
}

/// Keep the execution lease alive during repository preparation and transfer.
/// The operation must observe `cancel` so native Git is reaped before returning.
const DEVCONTAINER_REFUSAL: &str = "Remote Workspace devcontainer: ";

async fn with_authority<T>(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    shutdown: &CancellationToken,
    cancel: &CancellationToken,
    operation: impl std::future::Future<Output = Result<T, Status>>,
) -> Result<(T, Instant), Status> {
    let mut valid_until = renew_running_attempt(host, attempt, token).await?;
    tokio::pin!(operation);
    let mut interval = time::interval(Duration::from_secs(2));
    interval.tick().await;
    let error = loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break Status::cancelled("Worker Host is shutting down"),
            _ = time::sleep_until(valid_until) => break Status::failed_precondition("execution authority expired"),
            result = &mut operation => return result.map(|result| (result, valid_until)),
            _ = interval.tick() => {
                match time::timeout_at(valid_until, renew_running_attempt(host, attempt, token)).await {
                    Ok(Ok(until)) => valid_until = until,
                    Ok(Err(error)) if retryable(&error) => {},
                    Ok(Err(error)) => break error,
                    Err(_) => break Status::failed_precondition("execution authority expired"),
                }
            }
        }
    };
    cancel.cancel();
    let _ = operation.await;
    Err(error)
}

fn request<T>(message: T, token: &str) -> Result<Request<T>> {
    let mut request = authenticated_request(message, token, None)?;
    request.set_timeout(Duration::from_secs(5));
    Ok(request)
}

fn lost_ownership(error: &Status) -> bool {
    matches!(
        error.code(),
        Code::PermissionDenied | Code::FailedPrecondition | Code::NotFound
    )
}

fn retryable(error: &Status) -> bool {
    matches!(
        error.code(),
        Code::Unavailable | Code::DeadlineExceeded | Code::Cancelled
    ) || supertag_protocol::local_transport_failure(error)
}

async fn wait_for_work(shutdown: &CancellationToken) {
    tokio::select! {
        _ = time::sleep(Duration::from_millis(250)) => {}
        _ = shutdown.cancelled() => {}
    }
}
