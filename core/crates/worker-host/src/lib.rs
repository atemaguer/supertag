mod adapter;
mod artifact_direct;
mod artifact_inputs;
mod artifact_snapshots;
mod capture_volumes;
mod changed_paths;
mod checkpoints;
mod cleanup_failure;
pub mod context;
mod credentials;
pub mod egress;
mod enrollment;
pub mod environment;
mod failures;
mod guardian;
mod journal;
mod landing;
mod mcp;
mod native_memory;
mod native_memory_volume;
mod prepared;
mod provider_proxy;
mod readiness;
mod remote;
mod remote_provider;
mod shared_execution;
mod shared_host;
mod task_artifact_inputs;
mod task_outputs;
mod volume_objects;
mod workspace_mounts;
mod workspaces;

pub use adapter::unsandboxed_caveat;
pub use artifact_direct::{ArtifactPeers, ArtifactSourceConfig};
pub use credentials::{
    is_provider_secret, load_provider_credentials, provider_environment, provider_environment_for,
    provider_variable, validate_opencode_model,
};
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
        attempt_artifacts_client::AttemptArtifactsClient,
        attempt_changed_paths_client::AttemptChangedPathsClient,
        attempt_effects_client::AttemptEffectsClient, attempt_inputs_client::AttemptInputsClient,
        attempt_mailbox_client::AttemptMailboxClient,
        attempt_mcp_effects_client::AttemptMcpEffectsClient,
        attempt_memory_client::AttemptMemoryClient,
        attempt_schedules_client::AttemptSchedulesClient,
        attempt_tag_sessions_client::AttemptTagSessionsClient,
        attempt_task_files_client::AttemptTaskFilesClient,
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
    /// Where this host keeps the artifact and Workspace delivery bytes it holds; `None` keeps them in
    /// `STATE_DIRECTORY/artifacts`.
    pub artifact_source: Option<ArtifactSourceConfig>,
    pub artifact_peers: ArtifactPeers,
    pub workspace_mounts: WorkspaceMounts,
    /// File Volumes this host maps, by Volume ID. The work of a Tag that keeps it on one, such as
    /// its captures, is written there directly.
    pub volumes:
        std::collections::BTreeMap<String, supertag_workspaces::artifact_volumes::FileVolume>,
    /// Where reports sample free disk space, normally the state directory's filesystem.
    pub disk_space: environment::DiskSpaceSource,
    /// The OS command that keeps the machine awake while an Attempt runs, if any.
    pub keep_awake: Option<environment::KeepAwakeCommand>,
    /// Operator-declared placement labels. The host adds its operating system
    /// and architecture; the Control Plane derives harness and Workspace labels.
    pub labels: Vec<String>,
    /// Set when a supervisor runs this process as one execution lane of a shared Host.
    pub lane: Option<Lane>,
    /// Credentials the egress proxy injects for Tasks whose network scope names them.
    pub network_credentials: Vec<egress::HostCredential>,
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
    volumes: volume_objects::HostVolumes,
    volume_objects: volume_objects::VolumeObjects,
    workspace_mounts: AttemptWorkspaceMountsClient<InterceptedService<Channel, HostHeaders>>,
    workstreams: AttemptWorkstreamsClient<InterceptedService<Channel, HostHeaders>>,
    mailbox: AttemptMailboxClient<InterceptedService<Channel, HostHeaders>>,
    work_sessions: AttemptWorkSessionsClient<InterceptedService<Channel, HostHeaders>>,
    tag_sessions: AttemptTagSessionsClient<InterceptedService<Channel, HostHeaders>>,
    schedules: AttemptSchedulesClient<InterceptedService<Channel, HostHeaders>>,
    memory: AttemptMemoryClient<InterceptedService<Channel, HostHeaders>>,
    mcp_effects: AttemptMcpEffectsClient<InterceptedService<Channel, HostHeaders>>,
    changed_paths: AttemptChangedPathsClient<InterceptedService<Channel, HostHeaders>>,
    task_files: AttemptTaskFilesClient<InterceptedService<Channel, HostHeaders>>,
    effects: AttemptEffectsClient<InterceptedService<Channel, HostHeaders>>,
    /// Git for reading a reviewed delivery from its remote Workspace's Session branch.
    review_git: Option<supertag_git_delivery::GitDelivery>,
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
                    HarnessKind::ClaudeCode | HarnessKind::Opencode | HarnessKind::Cursor
                ) && attempt.shared_execution.is_none()
                    && !attempt.remote_file_workspace
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
            joined: assignment
                .joined
                .into_iter()
                .map(|message| journal::JoinedMessage {
                    task_id: message.task_id,
                    text: message.text,
                    sent_at_ms: message.sent_at_ms,
                })
                .collect(),
            native_memory: assignment
                .native_memory
                .map(|grant| journal::NativeMemoryGrant {
                    scope: grant.scope,
                    reset_generation: grant.reset_generation,
                    volume_head: grant.volume_head.and_then(|head| {
                        head.manifest
                            .map(|manifest| (head.revision, manifest.sha256, manifest.byte_length))
                    }),
                }),
            volume: assignment.volume.map(|volume| journal::AssignedVolume {
                volume_id: volume.volume_id,
                source: volume.source,
                revision: volume.revision,
            }),
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
        // `--once` answers whether there is work now; otherwise the Control Plane holds an empty
        // claim until a Task can be claimed.
        wait_ms: if options.once {
            0
        } else {
            CLAIM_WAIT.as_millis() as u32
        },
    }
}

/// How long the Control Plane may hold an empty claim. Inside the API tier's call budget.
const CLAIM_WAIT: Duration = Duration::from_secs(6);

pub async fn run(
    mut options: HostOptions,
    shutdown: CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    if let Some(token) = &options.token {
        failures::remember_credential(token);
    }
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
                || (matches!(
                    options.harness,
                    HarnessKind::Cursor | HarnessKind::ClaudeCode | HarnessKind::Opencode
                ) && !options.workspaces.is_empty()
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
            .map(|source| source.directory.clone())
            .unwrap_or_else(|| state_directory.join("artifacts"));
        options.workspace_mounts.protect(
            &state_directory,
            &local_roots,
            Some(artifact_storage.as_path()),
        )?;
    }
    let workspaces =
        workspaces::Workspaces::new(&options.state_directory, options.workspaces.clone())?;
    // Checkouts a crash left moved aside but not yet deleted.
    if !options.once {
        workspaces.purge_all_discarded_in_background();
    }
    // Terminal proof is durable; finishing local cleanup needs neither the source
    // repository nor a new network registration.
    if let Some(Entry::Terminal { attempt, prepared }) = journal.load()? {
        let discarded = cleanup_terminal(
            &journal,
            &workspaces,
            &options.state_directory,
            &attempt,
            prepared.as_deref(),
        )?;
        purge_discarded(discarded, options.once);
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
            Err(error) => return Err(error.at(options.control_plane.url()).into()),
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
    // This host holds every artifact and Workspace delivery it produces; the Control Plane relays
    // none of them.
    let serving = options
        .artifact_source
        .take()
        .unwrap_or_else(|| ArtifactSourceConfig::in_state(&options.state_directory))
        .bind(&options.state_directory, &local_roots)
        .await?
        .serve(acquisitions.clone(), &token, &shutdown)
        .await?;
    let coordination = CoordinationClients {
        review_git: supertag_git_delivery::GitDelivery::for_host(
            &options.state_directory.join("review-git"),
        )
        .ok(),
        acquisitions,
        artifact_source: Some(serving.storage.clone()),
        artifact_peers: options.artifact_peers.clone(),
        volumes: std::sync::Arc::new(options.volumes.clone()),
        volume_objects:
            supertag_protocol::v2::volume_objects_client::VolumeObjectsClient::with_interceptor(
                channel.clone(),
                headers.clone(),
            )
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        transfers: checkpoints::Transfers::new(channel.clone(), headers.clone())
            .with_storage(serving.storage.clone()),
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
        tag_sessions: AttemptTagSessionsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        schedules: AttemptSchedulesClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        memory: AttemptMemoryClient::with_interceptor(channel.clone(), headers.clone())
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
        task_files: AttemptTaskFilesClient::with_interceptor(channel.clone(), headers.clone())
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
    // Workspace deliveries and Session checkpoints stay in this host's artifact storage, which
    // every lane of the host shares; only their digests go upstream.
    let transfers = checkpoints::Transfers::new(channel.clone(), headers.clone())
        .with_storage(serving.storage.clone())
        .with_checkpoints(checkpoints::Held::new(
            serving.storage.root(),
            &registration.host_id,
        ))
        .with_volumes(std::sync::Arc::new(options.volumes.clone()));
    // This host lands the Workspace deliveries it holds: right after each one, and queued ones
    // (retries, merges after their Work Session closed) in the background. A `--once` host lands
    // only what it may claim before it exits.
    let landings = landing::Landings::new(
        &options.state_directory,
        channel.clone(),
        headers.clone(),
        &token,
        serving.storage.clone(),
    )?;
    if !options.once {
        landings.spawn(shutdown.clone());
    }
    // At start and every hour, delete the checkpoint files no Session will resume.
    {
        let transfers = transfers.clone();
        let token = token.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            loop {
                if let Err(error) = transfers.reconcile(&token).await {
                    crate::failures::note("held checkpoints could not be reconciled", &error);
                }
                tokio::select! {
                    () = shutdown.cancelled() => break,
                    () = tokio::time::sleep(Duration::from_secs(60 * 60)) => {}
                }
            }
        });
    }
    // At start and every 10 minutes, delete the objects nothing keeps from the file Volumes this
    // host maps.
    if !options.volumes.is_empty() {
        let volumes = std::sync::Arc::new(options.volumes.clone());
        let client = coordination.volume_objects.clone();
        let token = token.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            loop {
                if let Err(error) =
                    volume_objects::collect_garbage(client.clone(), &token, &volumes).await
                {
                    crate::failures::note("Volume garbage could not be deleted", &error);
                }
                tokio::select! {
                    () = shutdown.cancelled() => break,
                    () = tokio::time::sleep(volume_objects::GARBAGE_INTERVAL) => {}
                }
            }
        });
    }
    let mut host = WorkerHostClient::with_interceptor(channel, headers)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    // Preflight: warn before claiming work when the host is short of disk space.
    if let Some(warning) = environment::low_disk_warning(options.disk_space.sample().as_ref()) {
        supertag_protocol::terminal_text::warn(&warning);
    }
    if options.execution_profile.allow_unsandboxed_commands {
        let name = match options.harness {
            HarnessKind::ClaudeCode => "Claude Code",
            HarnessKind::Opencode => "OpenCode",
            HarnessKind::Cursor => "Cursor",
            _ => "This harness",
        };
        supertag_protocol::terminal_text::warn(&adapter::unsandboxed_caveat(name));
    }
    // A sign-in the provider proxy can't hold stays readable to commands run unsandboxed.
    if let Some(warning) = adapter::unproxied_key_warning(&options) {
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
    let mut announced_recovery: Option<String> = None;
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
                let mut claim = claim;
                if ready.is_some() {
                    // The host says it is ready after its first claim answers, so that one
                    // is not held.
                    claim.wait_ms = 0;
                }
                let mut claim_request = request(claim.clone(), &token)?;
                claim_request.set_timeout(CLAIM_WAIT + Duration::from_secs(3));
                let sent = Instant::now();
                let retired = async {
                    match &retire {
                        Some(retire) => retire.cancelled().await,
                        None => std::future::pending().await,
                    }
                };
                // Shutdown ends a held claim; the journaled Claim replays with the same operation
                // on the next start, so an assignment made meanwhile is not lost. Retirement ends
                // it too, and asks again at once with the same operation: an assignment made
                // meanwhile comes back and runs, and otherwise the lane leaves.
                let response = tokio::select! {
                    response = host.claim_task(claim_request) => response,
                    _ = shutdown.cancelled() => continue,
                    _ = retired => {
                        claim.wait_ms = 0;
                        host.claim_task(request(claim, &token)?).await
                    }
                };
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
                    failures::begin_attempt();
                    journal.save(&Entry::Starting {
                        attempt: Attempt::from_assignment(assignment)?,
                    })?;
                    supertag_protocol::crash_point("worker-host.start", "journaled");
                } else {
                    journal.clear()?;
                    if options.once {
                        return Ok(());
                    }
                    // A claim the Control Plane held already waited; claim again at once.
                    if sent.elapsed() >= Duration::from_secs(1) {
                        continue;
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
                        }
                        // Once per Attempt, however this host came to wait: it claims no work
                        // until the operator decides.
                        if announced_recovery.as_deref() != Some(attempt.attempt_id.as_str()) {
                            supertag_protocol::terminal_text::warn(&recovery_notice(&attempt));
                            announced_recovery = Some(attempt.attempt_id.clone());
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
                quiet,
                checkpoint,
                workspace,
                remote_tree,
                outputs,
                file_scope,
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
                            quiet,
                            checkpoint,
                            workspace,
                            remote_tree,
                            outputs: Some(pending),
                            file_scope,
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
                        .map_err(|error| crate::failures::noted(Status::internal("Workspace Volume write-back failed"), &error))?
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
                            .record_writes(request(report, &token).map_err(|error| crate::failures::noted(Status::internal("Workspace Volume write-back failed"), &error))?)
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
                        Err(error) => {
                            failures::note("Workspace Volume write-back failed", &error);
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
                            .await.map_err(|error| crate::failures::noted(Status::internal("artifact input cleanup failed"), &error))?
                            .map_err(|error| crate::failures::noted(Status::failed_precondition("artifact input files could not be removed safely"), &error))?;
                        if let Some(tree) = &remote_tree {
                            workspaces.restore_remote(&workspace, tree, &cancellation).await
                                .map_err(|error| crate::failures::noted(Status::invalid_argument("Remote Workspace output could not be restored safely"), &error))?;
                        }
                        if let Some(directory) = outputs.as_ref().and_then(|outputs| outputs.cleanup_directory()) {
                            let checkout = workspace.checkout.path.clone();
                            let directory = directory.to_owned();
                            tokio::task::spawn_blocking(move || {
                                supertag_workspaces::remove_output_directory(&checkout, &directory)
                                    .map_err(|error| crate::failures::noted(Status::failed_precondition("Task output directory could not be removed safely"), &error))
                            }).await.map_err(|error| crate::failures::noted(Status::internal("Task output cleanup failed"), &error))??;
                        }
                        workspaces
                            .finalize(&workspace, &result, (succeeded, file_scope.clone()), outputs.as_ref().map(|output| output.directory.as_str()), &cancellation)
                            .await
                            .map_err(|error| {
                                // The delivery check names the out-of-scope paths.
                                match error.downcast_ref::<supertag_workspaces::ScopeViolation>() {
                                    Some(violation) => Status::permission_denied(violation.to_string()),
                                    None => Status::invalid_argument(
                                        "Workspace output could not be captured safely",
                                    ),
                                }
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
                        quiet,
                        checkpoint,
                        workspace: Some(Box::new(pending)),
                        prepared: Some(workspace),
                        outputs,
                        failure_detail: if succeeded { vec![] } else { failures::take_detail() },
                    })?,
                    Err(_) if shutdown.is_cancelled() => return Ok(()),
                    Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
                    Err(error) if error.code() == Code::PermissionDenied => {
                        save_finish(&journal, attempt, adapter::failed(error.message()))?
                    }
                    Err(error) => {
                        failures::note("Workspace output could not be captured safely", &error);
                        save_finish(
                            &journal,
                            attempt,
                            adapter::failed("Workspace output could not be captured safely"),
                        )?
                    }
                }
            }
            Entry::Finish {
                attempt,
                result,
                succeeded,
                objective_signal,
                waiting_approval_ids,
                quiet,
                checkpoint,
                workspace,
                prepared,
                outputs,
                failure_detail,
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
                        Err(error) => {
                            failures::note("Workspace output no longer matches its receipt", &error);
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
                                quiet,
                                checkpoint,
                                workspace: Some(pending),
                                prepared,
                                outputs,
                                failure_detail: failure_detail.clone(),
                            })?;
                        }
                        Err(error)
                            if retryable(&error) || error.code() == Code::ResourceExhausted =>
                        {
                            wait_for_work(&shutdown).await
                        }
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(error) => {
                            failures::note("Workspace output could not be committed", &error);
                            save_finish(
                                &journal,
                                attempt,
                                adapter::failed("Workspace output could not be committed"),
                            )?
                        }
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
                            let payload = journal.read_checkpoint(&pending).map_err(|error| crate::failures::noted(Status::data_loss("staged checkpoint could not be read"), &error))?;
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
                                quiet,
                                checkpoint: Some(pending),
                                workspace,
                                prepared,
                                outputs,
                                failure_detail: failure_detail.clone(),
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
                            supertag_protocol::terminal_text::warn(&format!(
                                "Task {} Attempt {}: the Control Plane refused its Session checkpoint ({:?}): {}",
                                attempt.task_id,
                                attempt.attempt_id,
                                error.code(),
                                error.message()
                            ));
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
                            quiet,
                            checkpoint,
                            workspace,
                            prepared,
                            outputs: Some(pending),
                            failure_detail: failure_detail.clone(),
                        })?,
                        Err(error) if retryable(&error) || error.code() == Code::ResourceExhausted => wait_for_work(&shutdown).await,
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(error) => {
                            failures::note("Task output could not be committed", &error);
                            save_finish(
                                &journal,
                                attempt,
                                adapter::failed("Task output could not be committed"),
                            )?
                        }
                    }
                    continue;
                }
                supertag_protocol::crash_point("worker-host.finish", "journaled");
                // A local Workspace's Session branch goes into its own repository before the
                // Task is reported, so whoever sees it succeed finds the branch. Best effort: the
                // delivery stands either way, and a later delivery writes the branch again.
                if let Some(pending) = workspace.as_ref().filter(|_| succeeded) {
                    write_session_branch(&mut host, &workspaces, &attempt, &token, pending, &shutdown).await;
                }
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
                            quiet,
                            artifacts: outputs.as_ref().filter(|_| succeeded)
                                .and_then(|outputs| outputs.selection()).into_iter().collect(),
                            checkpoint_sha256: checkpoint.map(|pending| pending.sha256),
                            workspace_delivery: workspace
                                .as_ref()
                                .filter(|_| succeeded)
                                .map(|pending| workspaces.verify(pending))
                                .transpose()?,
                            failure_detail: if succeeded { vec![] } else { failure_detail.clone() },
                        },
                        &token,
                    )?)
                    .await;
                match outcome {
                    Ok(response) if response.get_ref().state() == TaskState::Uncertain => {
                        // Cleanup was observed, but the operator still owns the
                        // recovery decision. Preserve the checkout until its receipt.
                        // This host holds an outcome, so it never reclaims the Attempt itself.
                        supertag_protocol::terminal_text::warn(&format!(
                            "Task {} Attempt {} is uncertain: its execution lease lapsed before it finished, so the Control Plane cannot tell what it did (this host recorded it as {})",
                            attempt.task_id,
                            attempt.attempt_id,
                            if succeeded { "succeeded" } else { "failed" },
                        ));
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
                            quiet: false,
                            checkpoint: None,
                            workspace,
                            prepared,
                            outputs: None,
                            failure_detail: vec![],
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
                let discarded = cleanup_terminal(&journal, &workspaces, &options.state_directory, &attempt, prepared.as_deref())?;
                purge_discarded(discarded, options.once);
                landings.land_now(&shutdown).await;
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

/// Names the uncertain Attempt that keeps this host from claiming work, and the command that
/// resolves it.
fn recovery_notice(attempt: &Attempt) -> String {
    format!(
        "Task {task} Attempt {id} needs recovery before this host can claim work. Once you confirm its execution stopped: supertag task resolve-attempt {task} {id} --decision retry --confirmed-stopped --evidence TEXT (or --decision failed)",
        task = attempt.task_id,
        id = attempt.attempt_id,
    )
}

/// Ends a settled Attempt's local state. Its checkout is only moved aside here; deleting it,
/// which took seconds for a large repository, overlaps the next claim: see `purge_discarded`.
/// Returns the workspace state directory to purge.
fn cleanup_terminal(
    journal: &Journal,
    workspaces: &workspaces::Workspaces,
    state_directory: &std::path::Path,
    attempt: &Attempt,
    prepared: Option<&workspaces::PreparedWorkspace>,
) -> Result<Option<std::path::PathBuf>> {
    workspace_mounts::cleanup(state_directory, &attempt.attempt_id)?;
    let discarded = prepared
        .map(|prepared| workspaces.discard(prepared))
        .transpose()?;
    context::discard_attempt(state_directory, &attempt.attempt_id)?;
    journal.clear()?;
    Ok(discarded)
}

/// Deletes a discarded checkout in the background, so the next claim does not wait for it. A
/// `--once` host has no next claim and deletes it before it exits.
fn purge_discarded(state: Option<std::path::PathBuf>, once: bool) {
    let Some(state) = state else {
        return;
    };
    let purge = move || {
        if let Err(error) = supertag_workspaces::purge_discarded(&state) {
            failures::note_unrecorded("Discarded checkouts could not be deleted", &error);
        }
    };
    if once {
        purge();
    } else {
        std::thread::spawn(purge);
    }
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
    let discarded = cleanup_terminal(
        journal,
        workspaces,
        &options.state_directory,
        attempt,
        prepared.as_deref(),
    )?;
    purge_discarded(discarded, options.once);
    Ok(())
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
        let commit = match workspaces
            .resolve_ref(&workspace.workspace_id, &branch, shutdown)
            .await
        {
            workspaces::BranchResolution::Commit(commit) => commit,
            // Shutdown keeps the Starting entry, so recovery retries this exact Attempt.
            workspaces::BranchResolution::Interrupted => return Ok(()),
            workspaces::BranchResolution::Failed(message) => {
                return save_finish(journal, attempt, adapter::failed(&message));
            }
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
    if !supertag_protocol::network_scope::supports(
        &task,
        options.harness,
        &options.execution_profile,
    ) {
        return save_finish(
            journal,
            attempt,
            adapter::failed("Worker Host cannot enforce the Task's network scope"),
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
    let checkpoint = match time::timeout_at(
        valid_until,
        transfers.download(&attempt, token, (&task.tag_id, &task.session_id)),
    )
    .await
    {
        Ok(Ok(checkpoint)) => {
            checkpoint.filter(|checkpoint| checkpoints::resumable(options.harness, checkpoint))
        }
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
            Err(error) => {
                failures::note("Task Context Items could not be resolved safely", &error);
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
                error.downcast::<Status>().unwrap_or_else(|error| {
                    failures::noted(
                        Status::invalid_argument("Task workspace could not be prepared safely"),
                        &format!("{error:#}"),
                    )
                })
            })
    })
    .await;
    let (workspace, mut valid_until) = match prepared {
        Ok(prepared) => {
            if task.waiting_for_holder.is_some() {
                report_waiting_for_holder(host, &attempt, token, false).await;
            }
            // A remote Attempt's Workspace is ready once its sandbox is.
            if options.remote_provider.is_none() {
                report_milestone(host, &attempt.inspect(), token, WORKSPACE_READY);
            }
            prepared
        }
        Err(error) if retryable(&error) && !shutdown.is_cancelled() => {
            // The Session's last delivery is not readable here yet: its holder has not pushed it,
            // or holds a local Workspace. Say so once, so the Task shows what it waits for, then
            // keep trying.
            if error.code() == Code::Unavailable
                && error
                    .message()
                    .contains(supertag_protocol::WAITS_FOR_HOLDER)
                && task.waiting_for_holder.is_none()
            {
                report_waiting_for_holder(host, &attempt, token, true).await;
            }
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Err(error) => {
            // A failed setup names itself and keeps its untrusted output, as TypeScript's
            // `workspace-setup` failure does.
            let message = if error.message().starts_with("Workspace setup") {
                error.message()
            } else if error.message() == AUTHORITY_EXPIRED {
                "Execution authority expired while the Task workspace was prepared"
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
            Err(error) => {
                failures::note(
                    "Task artifact inputs could not be materialized safely",
                    &error,
                );
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
                .preflight(request(attempt.inspect(), token).map_err(|error| {
                    crate::failures::noted(
                        Status::internal("Workspace Volume request failed"),
                        &error,
                    )
                })?)
                .await?
                .into_inner();
            let protected = mappings.preflight(&mount_pins, current).map_err(|error| {
                crate::failures::noted(
                    Status::failed_precondition("Workspace Volume path admission failed"),
                    &error,
                )
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
            .map_err(|error| {
                crate::failures::noted(Status::internal("Workspace Volume staging failed"), &error)
            })?
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
            Err(error) => {
                failures::note("Workspace Volume staging failed", &error);
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
        Err(error) => {
            failures::note("Task output directory could not be prepared safely", &error);
            return save_finish(
                journal,
                attempt,
                adapter::failed("Task output directory could not be prepared safely"),
            );
        }
    };
    // A network scope runs this Attempt's egress proxy for as long as its harness runs. It starts
    // before a remote sandbox, whose commands reach it through the sandbox's relay.
    let egress = match supertag_protocol::network_scope::of_task(&task) {
        Some(scope) => Some(
            egress::start_for_attempt(
                scope,
                &options.network_credentials,
                &options.state_directory,
                &attempt.attempt_id,
                options.harness,
                options.remote_provider.is_some(),
            )
            .await
            .context("start the Attempt's egress proxy")?,
        ),
        None => None,
    };
    let mut sandbox_execution_ends = None;
    // A remote sandbox nothing needs before the Harness starts is prepared while it runs, so the
    // model starts without waiting for it; its first tool waits instead. Task artifact inputs and
    // Workspace copies are named by path at launch and staged in the background. MCP servers
    // need the sandbox first, since the Harness lists their tools when it starts, so then it is
    // prepared before.
    let defer_sandbox = options.remote_provider.is_some()
        && options.shared_execution.is_none()
        && workspace_mcp.is_none()
        && supertag_protocol::mcp::grants(&task).next().is_none();
    let mut deferred = None;
    let mut deferred_inputs = None;
    if defer_sandbox {
        let prepared = workspace
            .as_ref()
            .context("remote Attempt has no prepared Workspace")?;
        // The base commit's devcontainer subset is still read and refused before launch.
        let cancel = shutdown.child_token();
        match workspaces.remote_environment(prepared, &cancel).await {
            Ok(environment) => {
                // Inputs download now, without the sandbox, so the Harness reads their paths.
                if !task.input_artifacts.is_empty() || mounted.is_some() {
                    let downloaded = Box::pin(with_authority(
                        host,
                        &attempt,
                        token,
                        shutdown,
                        &cancel,
                        remote::download_inputs(&attempt, &task, (coordination, token), &cancel),
                    ))
                    .await;
                    let inputs = match downloaded {
                        Ok((inputs, expires)) => {
                            valid_until = expires;
                            inputs
                        }
                        Err(error) => {
                            return save_finish(
                                journal,
                                attempt,
                                adapter::failed(&format!(
                                    "Remote Workspace could not be prepared: {}",
                                    error.message()
                                )),
                            );
                        }
                    };
                    match remote::launch_instructions(&inputs, mounted.as_ref(), &attempt) {
                        Ok(Some(instructions)) => task.instructions.push_str(&instructions),
                        Ok(None) => {}
                        Err(error) => {
                            return save_finish(
                                journal,
                                attempt,
                                adapter::failed(&format!(
                                    "Remote Workspace could not be prepared: {error:#}"
                                )),
                            );
                        }
                    }
                    deferred_inputs = Some(inputs);
                }
                let (pending, ready) = adapter::RemoteWorkspace::pending();
                sandbox_execution_ends = Some(remote::execution_ends(options, mounted.as_ref()));
                deferred = Some((environment, pending, ready));
            }
            Err(error) => {
                return save_finish(
                    journal,
                    attempt,
                    adapter::failed(&format!("{DEVCONTAINER_REFUSAL}{error:#}")),
                );
            }
        }
    }
    // What a replacement for a lost sandbox starts from, once the first sandbox is prepared.
    let mut first_restart = None;
    let mut provider = if options.remote_provider.is_some() && !defer_sandbox {
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
                        None,
                    ),
                    (registration, coordination, token),
                    (egress.as_ref(), &cancel),
                )
                .await
                .map_err(|error| {
                    crate::failures::noted(
                        Status::failed_precondition("Remote Workspace could not be prepared"),
                        &error,
                    )
                })
            },
        ))
        .await;
        match prepared {
            Ok(((provider, instructions, execution_ends, restart), expires)) => {
                report_milestone(host, &attempt.inspect(), token, WORKSPACE_READY);
                if let Some(instructions) = instructions {
                    task.instructions.push_str(&instructions);
                }
                valid_until = expires;
                sandbox_execution_ends = Some(execution_ends);
                first_restart = Some(restart);
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
            Err(error) => {
                failures::note("Workspace MCP servers could not be prepared", &error);
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
            .map_err(|error| {
                crate::failures::noted(
                    Status::failed_precondition("shared execution access could not be prepared"),
                    &error,
                )
            })
        })
        .await
        {
            Ok((access, expires)) => {
                valid_until = expires;
                Some(access)
            }
            Err(error) => {
                failures::note(
                    "Shared execution access could not be prepared safely",
                    &error,
                );
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
    let (sandbox_environment, sandbox_ready) = match deferred {
        Some((environment, pending, ready)) => (Some((environment, pending)), Some(ready)),
        None => (None, None),
    };
    let (sandbox_environment, pending_workspace) = match sandbox_environment {
        Some((environment, pending)) => (Some(environment), Some(pending)),
        None => (None, None),
    };
    // A provider that finds the sandbox gone asks for a replacement here; see `replacer` below.
    let (replace_requests, mut replace_inbox) = tokio::sync::mpsc::channel(1);
    let (restart_ready, restart_watch) = tokio::sync::watch::channel(first_restart);
    let remote_workspace = provider
        .as_ref()
        .map(|provider: &remote_provider::RemoteProvider| {
            let (channel, token) = provider.workspace_connection();
            adapter::RemoteWorkspace::new(channel, token)
        })
        .or(pending_workspace)
        .map(|workspace| workspace.with_replacer(replace_requests.clone()))
        .or_else(|| shared_access.map(adapter::RemoteWorkspace::shared));
    drop(replace_requests);
    let adapter_workspace = workspace
        .as_ref()
        .filter(|_| remote_workspace.is_none())
        .map(|prepared| prepared.checkout.path.as_path());
    let output_directory = outputs
        .as_ref()
        .zip(adapter_workspace)
        .map(|(outputs, checkout)| outputs.absolute(checkout));
    if let Some(output) = outputs
        .as_ref()
        .filter(|_| options.remote_provider.is_some())
    {
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
    // A client on this machine reads a local checkout itself; the Control Plane only learns
    // where it is. A failed report only means the client can't find it.
    if let Some(prepared) = workspace.as_ref().filter(|_| adapter_workspace.is_some()) {
        let mut task_files = coordination.task_files.clone();
        let location = supertag_protocol::v2::ReportTaskFilesLocationRequest {
            attempt: Some(attempt.inspect()),
            local_path: prepared.checkout.path.to_string_lossy().into_owned(),
        };
        if let Ok(request) = request(location, token) {
            tokio::spawn(async move {
                let _ = task_files.report_location(request).await;
            });
        }
    }
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
    // The delivery check applies the Task's path scope to what it changed.
    let file_scope = supertag_protocol::file_scope::of_task(&task)
        .map(supertag_protocol::file_scope::Rules::from);
    let sandbox_task = defer_sandbox.then(|| task.clone());
    // The harness answers the joined messages in the same turn. The Task's stored prompt keeps
    // only the person's own text.
    task.prompt = joined_prompt(&task.prompt, &attempt.joined);
    let assignment = Assignment {
        native_memory: attempt.native_memory.as_ref().map(|grant| {
            supertag_protocol::v2::NativeMemoryGrant {
                scope: grant.scope.clone(),
                reset_generation: grant.reset_generation,
                volume_head: grant.volume_head.as_ref().map(|(revision, sha256, bytes)| {
                    supertag_protocol::v2::NativeMemoryVolumeHead {
                        revision: *revision,
                        manifest: Some(supertag_protocol::v2::BlobReference {
                            sha256: sha256.clone(),
                            byte_length: *bytes,
                        }),
                    }
                }),
            }
        }),
        volume: attempt
            .volume
            .as_ref()
            .map(|volume| supertag_protocol::v2::AssignedVolume {
                volume_id: volume.volume_id.clone(),
                source: volume.source.clone(),
                revision: volume.revision,
            }),
        task: Some(task),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
        joined: attempt
            .joined
            .iter()
            .map(|message| supertag_protocol::v2::JoinedMessage {
                task_id: message.task_id.clone(),
                text: message.text.clone(),
                sent_at_ms: message.sent_at_ms,
            })
            .collect(),
    };
    let sandbox_cancel = shutdown.child_token();
    let run = async {
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
                egress_environment: egress
                    .as_ref()
                    .map(|egress| egress.environment.clone())
                    .unwrap_or_default(),
            },
            (host.clone(), inputs.clone(), coordination.clone()),
            token,
            valid_until,
            shutdown,
        )
        .await;
        // A sandbox still being prepared, or replaced, when the Harness ends is no longer needed.
        sandbox_cancel.cancel();
        outcome
    };
    let background_sandbox = async {
        let (Some(ready), Some(prepared), Some(sandbox_task)) =
            (sandbox_ready, workspace.as_ref(), sandbox_task.as_ref())
        else {
            return None;
        };
        let result = remote::prepare(
            options,
            journal,
            workspaces,
            (&attempt, prepared, sandbox_task),
            (
                None,
                sandbox_environment.flatten(),
                mounted.as_ref(),
                deferred_inputs.take(),
            ),
            (registration, coordination, token),
            (egress.as_ref(), &sandbox_cancel),
        )
        .await;
        // Whether it failed while the Harness still ran, rather than being stopped after.
        let while_running = !sandbox_cancel.is_cancelled();
        if let Ok((_, _, _, restart)) = &result {
            report_milestone(host, &attempt.inspect(), token, WORKSPACE_READY);
            restart_ready.send_replace(Some(restart.clone()));
        }
        let _ = ready.send(Some(match &result {
            Ok((provider, _, _, _)) => Ok(provider.workspace_connection()),
            Err(_) => Err("Remote Workspace could not be prepared".to_owned()),
        }));
        Some((result, while_running))
    };
    // Replaces a sandbox its provider found gone, from the Attempt's starting files, while the
    // Harness runs. Returns the replacements, the last of which is the Attempt's sandbox now.
    let replacer = async {
        let mut replacements = Vec::new();
        loop {
            let reply = tokio::select! {
                request = replace_inbox.recv() => match request {
                    Some(reply) => reply,
                    None => break,
                },
                () = sandbox_cancel.cancelled() => break,
            };
            let Some(mut restart) = restart_watch.borrow().clone() else {
                let _ = reply.send(Err("the sandbox is not prepared yet"));
                continue;
            };
            let Some(prepared) = workspace.as_ref() else {
                let _ = reply.send(Err("the Attempt has no Workspace"));
                continue;
            };
            match remote::replace(
                options,
                journal,
                workspaces,
                (&attempt, prepared),
                (mounted.as_ref(), registration),
                &mut restart,
                &sandbox_cancel,
            )
            .await
            {
                Ok(replacement) => {
                    supertag_protocol::terminal_text::warn(&format!(
                        "Task {} Attempt {}: its remote sandbox was lost and replaced from the turn's starting files",
                        attempt.task_id, attempt.attempt_id
                    ));
                    let _ = reply.send(Ok(replacement.workspace_connection()));
                    replacements.push(replacement);
                }
                Err(error) => {
                    failures::note("A lost remote sandbox could not be replaced", &error);
                    let _ = reply.send(Err(if restart.replaced >= remote::MAX_REPLACEMENTS {
                        "this turn already replaced its sandbox twice"
                    } else {
                        "a new sandbox could not be prepared"
                    }));
                }
            }
            restart_ready.send_replace(Some(restart));
        }
        replacements
    };
    let (outcome, sandbox, mut replacements) = tokio::join!(run, background_sandbox, replacer);
    report_milestone(
        host,
        &attempt.inspect(),
        token,
        supertag_protocol::v2::AttemptMilestone::HarnessFinished,
    );
    let outcome = match sandbox {
        None => outcome,
        Some((Ok((prepared, _, _, _)), _)) => {
            provider = Some(prepared);
            outcome
        }
        Some((Err(error), while_running)) => {
            failures::note("Remote Workspace could not be prepared", &error);
            with_cleanup_authority(
                host,
                &attempt,
                token,
                shutdown,
                remote::ensure_stopped(options, journal, &attempt, registration),
            )
            .await?;
            // A sandbox that failed while the Harness ran fails the turn, as one that failed
            // before launch did; one stopped because the Harness ended first changes nothing.
            if while_running {
                outcome.map(|_| adapter::failed("Remote Workspace could not be prepared"))
            } else {
                outcome
            }
        }
    }
    // The adapter run's errors carry its cleanup marker and the Attempt's values to redact.
    .with_context(|| {
        format!(
            "Task {} Attempt {} needs recovery",
            attempt.task_id, attempt.attempt_id
        )
    });
    // The last replacement is the Attempt's sandbox now: capture and cleanup use it. The lost
    // sandboxes were stopped and their records retired; their provider processes only end here.
    if let Some(latest) = replacements.pop() {
        for mut lost in replacements.into_iter().chain(provider.replace(latest)) {
            let _ = lost.shutdown().await;
        }
    }
    stop_reports.cancel();
    if let Some(reports) = reports {
        let _ = reports.await;
    }
    if let Some(egress) = egress {
        egress.finish(host, &attempt, token).await;
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
                quiet: outcome.quiet,
                checkpoint,
                workspace: Box::new(workspace),
                remote_tree,
                outputs,
                file_scope,
            })
        } else {
            record_finish(journal, attempt.clone(), outcome)
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

/// Records a Worker Host's own verdict on an Attempt. A failure is also named in the Worker
/// Host log, so the operator reading it learns why without the Control Plane.
fn save_finish(journal: &Journal, attempt: Attempt, outcome: HarnessCompleteRequest) -> Result<()> {
    if !outcome.succeeded {
        supertag_protocol::terminal_text::warn(&format!(
            "Task {} Attempt {} failed: {}",
            attempt.task_id, attempt.attempt_id, outcome.result
        ));
    }
    record_finish(journal, attempt, outcome)
}

/// Records the adapter's outcome, which the adapter run already explained in the log.
fn record_finish(
    journal: &Journal,
    attempt: Attempt,
    outcome: HarnessCompleteRequest,
) -> Result<()> {
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
        quiet: outcome.quiet,
        checkpoint,
        workspace: None,
        prepared,
        outputs: None,
        failure_detail: if outcome.succeeded {
            vec![]
        } else {
            failures::take_detail()
        },
    })
}

async fn renew_running_attempt(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
) -> Result<Instant, Status> {
    let sent = Instant::now();
    let response = host
        .renew_attempt(request(attempt.inspect(), token).map_err(|error| {
            crate::failures::noted(Status::internal("invalid authority request"), &error)
        })?)
        .await?
        .into_inner();
    let task = response
        .task
        .as_ref()
        .ok_or_else(|| Status::data_loss("execution authority has no Task"))?;
    ensure_attempt(task, attempt).map_err(|error| {
        crate::failures::noted(
            Status::data_loss("execution authority has mismatched identity"),
            &error,
        )
    })?;
    if task.state() != TaskState::Running {
        return Err(Status::failed_precondition("execution authority ended"));
    }
    let until = sent
        .checked_add(Duration::from_millis(response.valid_for_ms))
        .ok_or_else(|| Status::data_loss("invalid authority duration"))?;
    if until <= Instant::now() {
        return Err(Status::failed_precondition(AUTHORITY_EXPIRED));
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

const DEVCONTAINER_REFUSAL: &str = "Remote Workspace devcontainer: ";

/// Keep the execution lease alive during repository preparation and transfer.
/// The operation must observe `cancel` so native Git is reaped before returning.
async fn with_authority<T>(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    shutdown: &CancellationToken,
    cancel: &CancellationToken,
    operation: impl std::future::Future<Output = Result<T, Status>>,
) -> Result<(T, Instant), Status> {
    let valid_until = renew_running_attempt(host, attempt, token).await?;
    let (host, attempt, token) = (host.clone(), attempt.clone(), token.to_owned());
    keep_authority(
        valid_until,
        move || {
            let (mut host, attempt, token) = (host.clone(), attempt.clone(), token.clone());
            async move { renew_running_attempt(&mut host, &attempt, &token).await }
        },
        Duration::from_secs(2),
        (shutdown, cancel),
        operation,
    )
    .await
}

/// Runs `operation` while `renew` extends authority that lasts until `valid_until`, every
/// `every`. Renewal runs as its own task, so an operation that blocks its thread, such as a
/// large checkout's file I/O, cannot starve the lease it runs under.
async fn keep_authority<T, F>(
    mut valid_until: Instant,
    mut renew: impl FnMut() -> F + Send + 'static,
    every: Duration,
    (shutdown, cancel): (&CancellationToken, &CancellationToken),
    operation: impl std::future::Future<Output = Result<T, Status>>,
) -> Result<(T, Instant), Status>
where
    F: std::future::Future<Output = Result<Instant, Status>> + Send + 'static,
{
    let (renewed, mut renewals) = tokio::sync::watch::channel(Ok(valid_until));
    let stop = shutdown.child_token();
    let renewal = AbortOnDrop(tokio::spawn(async move {
        let mut until = valid_until;
        let mut interval = time::interval(every);
        interval.tick().await;
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = interval.tick() => {}
            }
            let outcome = match time::timeout_at(until, renew()).await {
                Ok(Ok(next)) => Ok(next),
                Ok(Err(error)) if retryable(&error) => continue,
                Ok(Err(error)) => Err(error),
                Err(_) => Err(Status::failed_precondition(AUTHORITY_EXPIRED)),
            };
            let ended = outcome.is_err();
            if let Ok(next) = outcome {
                until = next;
            }
            if renewed.send(outcome).is_err() || ended {
                return;
            }
        }
    }));
    tokio::pin!(operation);
    let error = loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break Status::cancelled("Worker Host is shutting down"),
            _ = time::sleep_until(valid_until) => break Status::failed_precondition(AUTHORITY_EXPIRED),
            result = &mut operation => {
                if let Ok(until) = &*renewals.borrow() {
                    valid_until = valid_until.max(*until);
                }
                // An operation that held its thread past the lease must not report success:
                // the Control Plane already took the Attempt's authority back.
                if Instant::now() >= valid_until {
                    cancel.cancel();
                    return Err(Status::failed_precondition(AUTHORITY_EXPIRED));
                }
                return result.map(|result| (result, valid_until));
            }
            changed = renewals.changed() => {
                if changed.is_err() {
                    break Status::failed_precondition(AUTHORITY_EXPIRED);
                }
                match &*renewals.borrow_and_update() {
                    Ok(until) => valid_until = *until,
                    Err(error) => break error.clone(),
                }
            }
        }
    };
    drop(renewal);
    cancel.cancel();
    let _ = operation.await;
    Err(error)
}

/// What a lapsed execution lease reports.
const AUTHORITY_EXPIRED: &str = "execution authority expired";

/// Aborts a background task when its owner returns early.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
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

/// Records on the Task whether its Attempt waits for the Worker Host holding its Session's last
/// delivery. Best effort: a lost report only leaves the reason unshown until the next try.
/// Writes `pending`'s Session branch into its local Workspace's repository, noting a failure.
async fn write_session_branch(
    host: &mut RegisteredHost,
    workspaces: &workspaces::Workspaces,
    attempt: &Attempt,
    token: &str,
    pending: &workspaces::PendingWorkspace,
    shutdown: &CancellationToken,
) {
    let written = async {
        let authority = host
            .renew_attempt(request(attempt.inspect(), token)?)
            .await?
            .into_inner();
        let task = authority.task.context("Attempt authority names no Task")?;
        workspaces
            .write_session_branch(pending, &task.tag_id, &shutdown.child_token())
            .await
    }
    .await;
    if let Err(error) = written {
        failures::note_unrecorded(
            "the Session branch was not written to the Workspace",
            &error,
        );
    }
}

/// Tells the Control Plane, in the background and best-effort, that the Attempt reached
/// `milestone`, for `supertag metrics`. The run never waits on it.
pub(crate) fn report_milestone(
    host: &RegisteredHost,
    attempt: &supertag_protocol::v2::InspectAttemptRequest,
    token: &str,
    milestone: supertag_protocol::v2::AttemptMilestone,
) {
    let Ok(report) = request(
        supertag_protocol::v2::ReportAttemptMilestoneRequest {
            attempt: Some(attempt.clone()),
            milestone: milestone as i32,
        },
        token,
    ) else {
        return;
    };
    let mut host = host.clone();
    tokio::spawn(async move {
        if let Err(error) = host.report_attempt_milestone(report).await {
            tracing::debug!("could not report an Attempt milestone: {error}");
        }
    });
}

async fn report_waiting_for_holder(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    waiting: bool,
) {
    let Ok(report) = request(
        supertag_protocol::v2::ReportWaitingForHolderRequest {
            attempt: Some(attempt.inspect()),
            waiting,
        },
        token,
    ) else {
        return;
    };
    if let Err(error) = host.report_waiting_for_holder(report).await {
        tracing::debug!("could not report waiting for the delivery holder: {error}");
    }
}

const WORKSPACE_READY: supertag_protocol::v2::AttemptMilestone =
    supertag_protocol::v2::AttemptMilestone::WorkspaceReady;

async fn wait_for_work(shutdown: &CancellationToken) {
    tokio::select! {
        _ = time::sleep(Duration::from_millis(250)) => {}
        _ = shutdown.cancelled() => {}
    }
}

#[cfg(test)]
mod authority_tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    const VALID: Duration = Duration::from_millis(300);

    fn renewing(
        count: Arc<AtomicUsize>,
    ) -> impl FnMut() -> std::future::Ready<Result<Instant, Status>> {
        move || {
            count.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(Instant::now() + VALID))
        }
    }

    // A checkout's file I/O blocked the thread polling the operation for longer than the lease,
    // and the lease lapsed: renewal must not depend on that thread.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn renewal_continues_while_the_operation_blocks_its_thread() {
        let renewals = Arc::new(AtomicUsize::new(0));
        let (shutdown, cancel) = (CancellationToken::new(), CancellationToken::new());
        let result = keep_authority(
            Instant::now() + VALID,
            renewing(renewals.clone()),
            Duration::from_millis(50),
            (&shutdown, &cancel),
            async {
                std::thread::sleep(VALID * 3);
                Ok::<_, Status>("prepared")
            },
        )
        .await;
        let (value, valid_until) = result.expect("authority kept");
        assert_eq!(value, "prepared");
        assert!(valid_until > Instant::now());
        assert!(renewals.load(Ordering::SeqCst) >= 3);
        assert!(!cancel.is_cancelled());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_operation_that_outlives_its_lease_reports_the_lapse() {
        let (shutdown, cancel) = (CancellationToken::new(), CancellationToken::new());
        let result = keep_authority(
            Instant::now() + VALID,
            || std::future::ready(Err::<Instant, _>(Status::unavailable("Control Plane down"))),
            Duration::from_millis(50),
            (&shutdown, &cancel),
            async {
                std::thread::sleep(VALID * 2);
                Ok::<_, Status>(())
            },
        )
        .await;
        let error = result.expect_err("the lease lapsed");
        assert_eq!(error.code(), Code::FailedPrecondition);
        assert_eq!(error.message(), AUTHORITY_EXPIRED);
    }

    #[tokio::test]
    async fn a_refused_renewal_cancels_the_operation() {
        let (shutdown, cancel) = (CancellationToken::new(), CancellationToken::new());
        let stopped = cancel.clone();
        let result = keep_authority(
            Instant::now() + Duration::from_secs(30),
            || {
                std::future::ready(Err::<Instant, _>(Status::failed_precondition(
                    "execution authority ended",
                )))
            },
            Duration::from_millis(20),
            (&shutdown, &cancel),
            async move {
                stopped.cancelled().await;
                Err::<(), _>(Status::cancelled("stopped"))
            },
        )
        .await;
        let error = result.expect_err("authority ended");
        assert_eq!(error.message(), "execution authority ended");
        assert!(cancel.is_cancelled());
    }
}

/// A Task's prompt followed by the messages joined into its Attempt, oldest first.
fn joined_prompt(prompt: &str, joined: &[journal::JoinedMessage]) -> String {
    if joined.is_empty() {
        return prompt.to_owned();
    }
    let mut text = format!("{prompt}\n\nMore messages sent before you started (oldest first):");
    for message in joined {
        let minutes = message.sent_at_ms.max(0) / 60_000 % (24 * 60);
        text.push_str(&format!(
            "\n[{:02}:{:02} UTC] {}",
            minutes / 60,
            minutes % 60,
            message.text
        ));
    }
    text.push_str("\nAnswer them together.");
    text
}

#[cfg(test)]
mod joined_prompt_tests {
    use super::*;

    #[test]
    fn joined_messages_follow_the_prompt_oldest_first() {
        assert_eq!(joined_prompt("Check CI", &[]), "Check CI");
        let joined = [
            journal::JoinedMessage {
                task_id: "a".into(),
                text: "also the flaky test".into(),
                sent_at_ms: 1_794_470_160_000,
            },
            journal::JoinedMessage {
                task_id: "b".into(),
                text: "and open a PR".into(),
                sent_at_ms: 1_794_470_220_000,
            },
        ];
        assert_eq!(
            joined_prompt("Check CI", &joined),
            "Check CI\n\nMore messages sent before you started (oldest first):\n[07:56 UTC] also the flaky test\n[07:57 UTC] and open a PR\nAnswer them together."
        );
    }
}
