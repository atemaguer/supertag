//! A Worker Host: the Worklet (`worklet/`), the per-host program that registers, claims, holds
//! leases, and recovers, and the Worker (`worker/`), which runs one Task Attempt.

mod artifact_inputs;
mod artifact_snapshots;
mod credentials;
pub mod environment;
mod failures;
mod local;
mod worker;
mod worklet;
mod workspace_mounts;

pub use credentials::{
    is_provider_secret, provider_environment, provider_environment_for, provider_variable,
    read_provider_credentials, validate_opencode_model,
};
pub use worker::adapter::unsandboxed_caveat;
pub use worker::codex_exec::run_bridge as run_codex_exec_bridge;
pub use worker::guardian::{ADAPTER_STATE_DIRECTORY, guard_adapter};
pub use worker::mcp::{
    McpCatalog, McpCatalogEntry, McpLogin, McpLoginOptions, McpLoginState, McpLoginStore,
    login_command as mcp_login_command, run_mcp_login,
};
pub use worker::process::{DataDialer, WorkerProcessOptions, protect_worker_channel, run_worker};
pub use worker::remote_provider::{ProviderAuthority, ProviderConfig};
pub use worker::shared_execution::SharedExecutionConfig;
pub use worker::{WorkerOptions, context, egress};
pub use worklet::artifact_direct::{ArtifactPeers, ArtifactSourceConfig};
pub use worklet::enrollment::{
    EnrolledRole, credential, enroll, enrolled_control_plane, enrolled_host, rotate_own_credential,
};
pub use worklet::readiness::host_labels;
pub use worklet::workers::{RunningState, RunningWorker, WORKERS_FILE, running_workers};
pub use worklet::workspaces::{WORKSPACE_DIRECTORY, WorkspaceMapping, WorkspaceSource};
pub use worklet::{HarnessService, WorkerLaunch, WorkletOptions};
pub use workspace_mounts::WorkspaceMounts;

use std::time::Duration;

use anyhow::{Result, ensure};
use prost::Message;
use supertag_protocol::{
    HOST_GENERATION_HEADER, authenticated_request, negotiation,
    v2::{
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
use worklet::journal::Attempt;

/// Runs this Worker Host's Worklet until `shutdown`, calling `ready` once it can take work. The
/// Worklet runs each Attempt it claims in a Worker process it starts with its harness's
/// `WorkerLaunch`.
pub async fn run(
    worklet: WorkletOptions,
    shutdown: CancellationToken,
    ready: impl FnOnce() + Send + 'static,
) -> Result<()> {
    worklet::run::run(worklet, shutdown, ready).await
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
/// The Attempt-scoped data clients a Worker's harness bridge and setup relay its calls through:
/// the data half of `WorkerHost`, Mailbox, Workstreams, Memory, Tag and Work Sessions,
/// Schedules, Effects, Task files, artifact captures and acquisition, and Workspace mounts. The
/// Worker builds them on its own channel to its data endpoint; they hold no credential, and
/// every call carries the Attempt credential. The host's own storage is `HostStorage`.
#[derive(Clone)]
pub(crate) struct AttemptClients {
    attempt: worklet::authority::AttemptClient,
    acquisitions: AttemptArtifactsClient<InterceptedService<Channel, HostHeaders>>,
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
}

impl Attempt {
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
