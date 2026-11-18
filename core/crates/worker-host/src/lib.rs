//! A Worker Host: the Worklet (`worklet/`), the per-host program that registers, claims, holds
//! leases, and recovers, and the Worker (`worker/`), which runs one Task Attempt.

mod artifact_inputs;
mod artifact_snapshots;
mod credentials;
pub mod environment;
mod failures;
mod worker;
mod worklet;
mod workspace_mounts;

use worklet::{artifact_direct, checkpoints, volume_objects};

pub use credentials::{
    is_provider_secret, load_provider_credentials, provider_environment, provider_environment_for,
    provider_variable, validate_opencode_model,
};
pub use worker::adapter::unsandboxed_caveat;
pub use worker::codex_exec::run_bridge as run_codex_exec_bridge;
pub use worker::guardian::{ADAPTER_STATE_DIRECTORY, guard_adapter};
pub use worker::mcp::{
    McpCatalog, McpCatalogEntry, McpLogin, McpLoginOptions, McpLoginState, McpLoginStore,
    login_command as mcp_login_command, run_mcp_login,
};
pub use worker::remote_provider::{ProviderAuthority, ProviderConfig};
pub use worker::shared_execution::SharedExecutionConfig;
pub use worker::{context, egress};
pub use worklet::artifact_direct::{ArtifactPeers, ArtifactSourceConfig};
pub use worklet::enrollment::{
    EnrolledRole, credential, enroll, enrolled_control_plane, enrolled_host, rotate_own_credential,
};
pub use worklet::readiness::{LaneObserver, State as LaneState, host_labels};
pub use worklet::shared_host::{
    HarnessSlots, SharedHost, holds_attempt, transient as presence_retryable,
};
pub use worklet::workspaces::{WORKSPACE_DIRECTORY, WorkspaceMapping, WorkspaceSource};
pub use workspace_mounts::WorkspaceMounts;

use std::{ffi::OsString, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use prost::Message;
use supertag_protocol::{
    HOST_GENERATION_HEADER, authenticated_request, negotiation,
    v2::{
        Assignment, AttemptExecutionSelection, HarnessExecutionProfile, HarnessKind,
        InspectAttemptRequest, Task, attempt_artifacts_client::AttemptArtifactsClient,
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
use tokio::time::{self};
use tokio_util::sync::CancellationToken;
use tonic::{
    Code, Request, Status,
    metadata::{Ascii, MetadataValue},
    service::{Interceptor, interceptor::InterceptedService},
    transport::Channel,
};
use worklet::journal::{self, Attempt};

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

/// Runs this Worker Host's Worklet until `shutdown`, calling `ready` once it can take work.
pub async fn run(
    options: HostOptions,
    shutdown: CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    worklet::run::run(options, shutdown, ready).await
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
