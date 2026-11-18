pub(crate) mod artifact_acquisition;
mod artifact_capture;
mod effects;
mod inputs;
mod limits;
mod mcp;
mod memory;
mod questions;
mod review_artifacts;
mod schedules;
mod tag_sessions;
mod text;
mod work_sessions;
mod workspace;
pub(crate) use workspace::RemoteWorkspace;
mod workstreams;

use std::{
    collections::HashSet,
    ffi::OsStr,
    io,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use prost::Message;
use supertag_protocol::redaction::{
    SensitiveValue, redact_text, sensitive_environment_values, unique_sensitive_values,
};
use supertag_protocol::{
    MAX_CHECKPOINT_BYTES, MAX_MESSAGE_BYTES, authenticated_request, matches_bearer,
    v2::{
        AdapterBootstrap, AppendEventRequest, AppliedExecutionLimits, Assignment,
        ConfirmExecutionLimitsResponse, ExecutionLimits, HarnessAttachRequest,
        HarnessCompleteRequest, HarnessCompleteResponse, HarnessKind, HarnessPublishRequest,
        HarnessPublishTextRequest, HarnessPublishTextResponse, HarnessRun,
        HarnessSettleLiveInputRequest, HarnessTakeLiveInputRequest, HarnessUsageRequest,
        InspectAttemptRequest, LiveInput, ObjectiveSignal, ReportAppliedLimitsRequest,
        ReportAttemptUsageRequest, ReportAttemptUsageResponse, ReportedCostLimit, ResolvedSkill,
        SessionCheckpoint, TakeInputResponse, TaskEvent, TaskEventKind, TaskState,
        harness_server::{Harness, HarnessServer},
    },
    validate_checkpoint_reference,
};
use tokio::{
    io::AsyncWriteExt,
    net::TcpListener,
    process::{Child, Command},
    sync::{Mutex, Semaphore},
    time::{self, Instant},
};
use tokio_stream::wrappers::TcpListenerStream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status, transport::Server};
use uuid::Uuid;

use crate::{
    CoordinationClients, HostOptions, RegisteredHost, RegisteredInputs,
    artifact_snapshots::Snapshots,
    guardian::{MAX_BOOTSTRAP_BYTES, monotonic_now_ns},
};

#[derive(Clone)]
struct Bridge {
    token: String,
    assignment: Assignment,
    checkpoint: Option<SessionCheckpoint>,
    resolved_skills: Vec<ResolvedSkill>,
    host_token: String,
    host: RegisteredHost,
    harness: HarnessKind,
    coordination: CoordinationClients,
    state: Arc<Mutex<RunState>>,
    attached: Arc<AtomicBool>,
    inputs: inputs::InputLane,
    workspace: Option<workspace::RemoteWorkspace>,
    mcp: Option<Arc<crate::mcp::AttemptMcp>>,
    mcp_lane: Arc<Mutex<()>>,
    artifact_checkout: Option<(PathBuf, Snapshots)>,
    artifact_inputs: Option<crate::artifact_inputs::Inputs>,
    artifact_capacity: Arc<Semaphore>,
    /// Secrets this host knows, hidden from every text the harness sends upstream.
    secrets: Arc<Vec<SensitiveValue>>,
    /// The message the harness is writing now.
    text: text::SharedTextStream,
}

#[derive(Default)]
struct RunState {
    outcome: Option<HarnessCompleteRequest>,
    observed_approvals: HashSet<String>,
    applied_limits: Option<AppliedExecutionLimits>,
    native_usage_sequence: u64,
    reported_tokens: Option<u64>,
    measured_cost: Option<ReportedCostLimit>,
}

impl Bridge {
    /// Hides credentials in harness text before it leaves the Worker Host: explicit URL and
    /// authorization credentials, and the values of this host's credential variables, its own
    /// credential, and the adapter's bootstrap token, in any of their encodings.
    fn redact(&self, text: &str) -> String {
        redact_text(text, &self.secrets, false)
    }

    /// Redacts `text` that the Control Plane accepts up to `limit` bytes. `[REDACTED]` can be
    /// longer than a short secret it replaces, so text within the limit stays within it; text
    /// already over the limit is left for the Control Plane to refuse.
    fn redact_within(&self, text: &str, limit: usize) -> String {
        let redacted = self.redact(text);
        if text.len() > limit {
            redacted
        } else {
            bounded(redacted, limit)
        }
    }

    /// Repeats an idempotent upstream call across a transient Control Plane partition
    /// until execution authority ends, so the harness does not fail for a
    /// disconnect its Worker Host is still allowed to ride out.
    async fn retry_upstream<M, R, F, Fut>(&self, message: M, mut call: F) -> Result<R, Status>
    where
        M: Clone,
        F: FnMut(RegisteredHost, Request<M>) -> Fut,
        Fut: std::future::Future<Output = Result<Response<R>, Status>>,
    {
        self.retry(message, |request| call(self.host.clone(), request))
            .await
            .map(Response::into_inner)
    }

    /// Repeats one idempotent upstream call within execution authority; see
    /// `InputLane::retry`, which every adapter-facing retry goes through.
    async fn retry<M, R, F, Fut>(&self, message: M, call: F) -> Result<Response<R>, Status>
    where
        M: Clone,
        F: FnMut(Request<M>) -> Fut,
        Fut: std::future::Future<Output = Result<Response<R>, Status>>,
    {
        self.inputs.retry(message, &self.host_token, call).await
    }

    fn authenticate<T>(&self, request: &Request<T>) -> Result<(), Status> {
        if !matches_bearer(request, &self.token) {
            return Err(Status::unauthenticated("execution credential required"));
        }
        Ok(())
    }

    fn task_id(&self) -> &str {
        &self
            .assignment
            .task
            .as_ref()
            .expect("validated assignment")
            .task_id
    }

    fn attempt(&self) -> InspectAttemptRequest {
        InspectAttemptRequest {
            task_id: self.task_id().into(),
            attempt_id: self.assignment.attempt_id.clone(),
            lease_token: self.assignment.lease_token.clone(),
        }
    }

    fn require_attached(&self) -> Result<(), Status> {
        if !self.attached.load(Ordering::Acquire) {
            return Err(Status::failed_precondition("adapter must attach first"));
        }
        Ok(())
    }

    fn execution_limits(&self) -> Option<&ExecutionLimits> {
        self.assignment.task.as_ref()?.execution_limits.as_ref()
    }
}

#[tonic::async_trait]
impl Harness for Bridge {
    async fn attach(
        &self,
        request: Request<HarnessAttachRequest>,
    ) -> Result<Response<HarnessRun>, Status> {
        self.authenticate(&request)?;
        let capabilities = self
            .retry_upstream(self.attempt(), |mut host, request| async move {
                host.get_attempt_capabilities(request).await
            })
            .await?;
        // Every harness gets the recap: an adapter that cannot resume its checkpoint, or has
        // none, starts a fresh native session from it.
        let history = self
            .retry_upstream(self.attempt(), |mut host, request| async move {
                host.get_attempt_history(request).await
            })
            .await?
            .entries;
        if !self.attached.swap(true, Ordering::AcqRel) {
            crate::report_milestone(
                &self.host,
                &self.attempt(),
                &self.host_token,
                supertag_protocol::v2::AttemptMilestone::AdapterAttached,
            );
        }
        Ok(Response::new(HarnessRun {
            task: self.assignment.task.clone(),
            attempt_id: self.assignment.attempt_id.clone(),
            checkpoint: self.checkpoint.clone(),
            may_ask_objective_question: capabilities.may_ask_objective_question,
            coordination: Some(capabilities),
            resolved_skills: self.resolved_skills.clone(),
            history,
            remote_workspace: self.workspace.is_some(),
            may_capture_artifacts: self.artifact_checkout.is_some(),
            may_acquire_artifacts: true,
            may_materialize_artifacts: self.artifact_inputs.is_some(),
            shared_execution: self
                .workspace
                .as_ref()
                .and_then(workspace::RemoteWorkspace::shared_summary),
        }))
    }

    async fn confirm_execution_limits(
        &self,
        request: Request<AppliedExecutionLimits>,
    ) -> Result<Response<ConfirmExecutionLimitsResponse>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let applied = request.into_inner();
        // The check runs again after the report, which runs without the bridge lock so other
        // bridge calls never wait on the Control Plane.
        let check = |state: &RunState| -> Result<bool, Status> {
            if let Some(previous) = &state.applied_limits {
                if previous != &applied {
                    return Err(Status::already_exists(
                        "adapter already confirmed different execution limits",
                    ));
                }
                return Ok(true);
            }
            if state.outcome.is_some() {
                return Err(Status::failed_precondition("execution is complete"));
            }
            Ok(false)
        };
        if check(&*self.state.lock().await)? {
            return Ok(Response::new(ConfirmExecutionLimitsResponse {}));
        }
        limits::verify_confirmation(self.harness, self.execution_limits(), &applied)?;
        // The Task execution report shows what the adapter applied. The Control Plane accepts
        // a repeated report of the same limits and refuses different ones.
        let report = ReportAppliedLimitsRequest {
            attempt: Some(InspectAttemptRequest {
                task_id: self.task_id().into(),
                attempt_id: self.assignment.attempt_id.clone(),
                lease_token: self.assignment.lease_token.clone(),
            }),
            applied: Some(applied.clone()),
        };
        self.retry_upstream(report, |mut host, request| async move {
            host.report_applied_limits(request).await
        })
        .await?;
        let mut state = self.state.lock().await;
        if !check(&state)? {
            state.applied_limits = Some(applied);
        }
        Ok(Response::new(ConfirmExecutionLimitsResponse {}))
    }

    async fn publish(
        &self,
        request: Request<HarnessPublishRequest>,
    ) -> Result<Response<TaskEvent>, Status> {
        self.authenticate(&request)?;
        let state = self.state.lock().await;
        if !self.attached.load(Ordering::Acquire) || state.outcome.is_some() {
            return Err(Status::failed_precondition(
                "execution is not accepting events",
            ));
        }
        let event = request.into_inner();
        let append = AppendEventRequest {
            task_id: self.task_id().into(),
            attempt_id: self.assignment.attempt_id.clone(),
            lease_token: self.assignment.lease_token.clone(),
            sequence: event.sequence,
            text: self.redact_within(&event.text, MAX_EVENT_TEXT_BYTES),
            kind: event.kind,
        };
        // The Control Plane deduplicates an event by sequence and content, so an
        // append whose outcome the transport lost is safely repeated.
        let event = self
            .retry_upstream(append, |mut host, request| async move {
                host.append_event(request).await
            })
            .await?;
        supertag_protocol::crash_point("worker-host.append-event", "answered");
        drop(state);
        if event.kind == TaskEventKind::Message as i32 {
            // The recorded message replaces the text written so far.
            *self.text.lock().unwrap() = Default::default();
        }
        Ok(Response::new(event))
    }

    async fn publish_text(
        &self,
        request: Request<HarnessPublishTextRequest>,
    ) -> Result<Response<HarnessPublishTextResponse>, Status> {
        Bridge::publish_text(self, request).await
    }

    async fn report_usage(
        &self,
        request: Request<HarnessUsageRequest>,
    ) -> Result<Response<ReportAttemptUsageResponse>, Status> {
        self.authenticate(&request)?;
        let mut state = self.state.lock().await;
        if !self.attached.load(Ordering::Acquire) || state.outcome.is_some() {
            return Err(Status::failed_precondition(
                "execution is not accepting usage",
            ));
        }
        let usage = request.into_inner();
        if usage.amount_minor.is_some() != usage.currency.is_some()
            || (usage.native_usage.is_none() && usage.amount_minor.is_none())
        {
            return Err(Status::invalid_argument(
                "native token usage or a reported cost is required",
            ));
        }
        let native_receipt = usage
            .native_usage
            .as_ref()
            .map(|native| (usage.sequence, native.total_tokens));
        let measured_cost = if usage.estimated {
            None
        } else {
            usage
                .amount_minor
                .zip(usage.currency.clone())
                .map(|(amount_minor, currency)| ReportedCostLimit {
                    currency,
                    amount_minor,
                })
        };
        // The Control Plane accepts an exact repeat of a usage sequence, so a
        // report whose answer the transport lost is safely sent again.
        let report = ReportAttemptUsageRequest {
            attempt: Some(self.attempt()),
            sequence: usage.sequence,
            amount_minor: usage.amount_minor,
            currency: usage.currency,
            estimated: usage.estimated,
            native_usage: usage.native_usage,
        };
        let response = self
            .retry(report, |request| {
                let mut host = self.host.clone();
                async move { host.report_attempt_usage(request).await }
            })
            .await?;
        if let Some((sequence, tokens)) = native_receipt
            && sequence >= state.native_usage_sequence
        {
            state.native_usage_sequence = sequence;
            state.reported_tokens = tokens;
        }
        if let Some(cost) = measured_cost
            && state
                .measured_cost
                .as_ref()
                .is_none_or(|prior| cost.amount_minor >= prior.amount_minor)
        {
            state.measured_cost = Some(cost);
        }
        Ok(response)
    }

    async fn complete(
        &self,
        request: Request<HarnessCompleteRequest>,
    ) -> Result<Response<HarnessCompleteResponse>, Status> {
        self.authenticate(&request)?;
        let _mcp_call = if self.mcp.is_some() {
            Some(self.mcp_lane.lock().await)
        } else {
            None
        };
        let mut state = self.state.lock().await;
        if !self.attached.load(Ordering::Acquire) {
            return Err(Status::failed_precondition(
                "adapter must attach before proposing a result",
            ));
        }
        let mut outcome = request.into_inner();
        outcome.result = self.redact_within(&outcome.result, MAX_RESULT_BYTES);
        outcome.checkpoint = crate::checkpoints::kept(outcome.checkpoint.take());
        if outcome.result.len() > MAX_RESULT_BYTES
            || outcome.result.contains('\0')
            || ObjectiveSignal::try_from(outcome.objective_signal).is_err()
            || (!outcome.succeeded && outcome.objective_signal != ObjectiveSignal::Progress as i32)
            || (!outcome.succeeded && outcome.quiet)
            || (!outcome.waiting_approval_ids.is_empty()
                && (!outcome.succeeded
                    || outcome.objective_signal != ObjectiveSignal::Progress as i32
                    || outcome.waiting_approval_ids.len() > 32
                    || outcome
                        .waiting_approval_ids
                        .iter()
                        .any(|id| !state.observed_approvals.contains(id))))
        {
            return Err(Status::invalid_argument("invalid harness outcome"));
        }
        if let Some(checkpoint) = &outcome.checkpoint {
            if !outcome.succeeded {
                return Err(Status::invalid_argument(
                    "failed execution cannot propose a checkpoint",
                ));
            }
            validate_checkpoint_reference(&checkpoint.reference())?;
        }
        if let Some(previous) = &state.outcome {
            if previous != &outcome {
                return Err(Status::already_exists(
                    "adapter already proposed a different result",
                ));
            }
        } else {
            if outcome.succeeded {
                limits::verify_success(
                    self.execution_limits(),
                    state.applied_limits.as_ref(),
                    state.reported_tokens,
                    state.measured_cost.as_ref(),
                )?;
            }
            state.outcome = Some(outcome);
            self.inputs.close();
        }
        Ok(Response::new(HarnessCompleteResponse {}))
    }

    async fn take_live_input(
        &self,
        request: Request<HarnessTakeLiveInputRequest>,
    ) -> Result<Response<TakeInputResponse>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        self.inputs.take(self.attempt(), &self.host_token).await
    }

    async fn settle_live_input(
        &self,
        request: Request<HarnessSettleLiveInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        self.inputs
            .settle(self.attempt(), request.into_inner(), &self.host_token)
            .await
    }
}

pub(crate) struct ExecutionInputs<'a> {
    pub checkpoint: Option<SessionCheckpoint>,
    pub workspace: Option<&'a Path>,
    pub output_directory: Option<&'a Path>,
    pub resolved_skills: Vec<ResolvedSkill>,
    pub remote_workspace: Option<workspace::RemoteWorkspace>,
    pub mcp: Option<Arc<crate::mcp::AttemptMcp>>,
    /// Where the adapter's process group is recorded before it starts.
    pub processes: crate::journal::Processes,
    /// When a remote sandbox's harness must stop to leave its cleanup margin.
    pub sandbox_execution_ends: Option<Instant>,
    /// The Attempt's egress proxy variables for the adapter, when its Task has a network scope.
    pub egress_environment: Vec<(String, std::ffi::OsString)>,
}

/// Runs the Attempt's adapter. Every error leaves the Attempt's cleanup unconfirmed, and carries
/// the values its reasons must redact: this run's redaction set and the Attempt's resolved MCP
/// credentials.
pub(crate) async fn execute(
    options: &HostOptions,
    assignment: Assignment,
    inputs: ExecutionInputs<'_>,
    clients: (RegisteredHost, RegisteredInputs, CoordinationClients),
    host_token: &str,
    valid_until: Instant,
    shutdown: &CancellationToken,
) -> Result<HarnessCompleteRequest> {
    let bootstrap_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let secrets = Arc::new(host_secrets(&[host_token, &bootstrap_token]));
    let mcp_secrets = inputs
        .mcp
        .as_ref()
        .map(|mcp| mcp.secrets().to_vec())
        .unwrap_or_default();
    run(
        options,
        assignment,
        inputs,
        clients,
        (host_token, bootstrap_token, secrets.clone()),
        valid_until,
        shutdown,
    )
    .await
    .map_err(|error| {
        let mut redacting = secrets.as_ref().clone();
        redacting.extend(mcp_secrets.into_iter().map(SensitiveValue::High));
        error.context(crate::cleanup_failure::CleanupUnconfirmed::redacting(
            unique_sensitive_values(redacting),
        ))
    })
}

async fn run(
    options: &HostOptions,
    assignment: Assignment,
    ExecutionInputs {
        checkpoint,
        workspace,
        output_directory,
        resolved_skills,
        remote_workspace,
        mcp,
        processes,
        sandbox_execution_ends,
        egress_environment,
    }: ExecutionInputs<'_>,
    (host, inputs, coordination): (RegisteredHost, RegisteredInputs, CoordinationClients),
    (host_token, bootstrap_token, secrets): (&str, String, Arc<Vec<SensitiveValue>>),
    valid_until: Instant,
    shutdown: &CancellationToken,
) -> Result<HarnessCompleteRequest> {
    ensure!(assignment.task.is_some(), "assignment is missing its Task");
    let native_memory =
        prepare_native_memory(options, &assignment, &coordination, host_token).await;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let bootstrap = AdapterBootstrap {
        endpoint: format!("http://{}", listener.local_addr()?),
        token: bootstrap_token,
    };
    let artifact_checkout = workspace
        .filter(|_| {
            assignment.task.as_ref().is_some_and(|task| {
                task.allowed_actions
                    .iter()
                    .any(|action| action == "files:read")
            })
        })
        .map(|path| {
            Ok::<_, anyhow::Error>((
                path.to_owned(),
                Snapshots::open(&options.state_directory, &assignment.attempt_id)?,
            ))
        })
        .transpose()?;
    let artifact_inputs = artifact_checkout
        .as_ref()
        .filter(|_| remote_workspace.is_none())
        .map(|(path, _)| {
            crate::artifact_inputs::Inputs::prepare_optional(
                &options.state_directory,
                &assignment.attempt_id,
                path,
            )
        })
        .transpose()?
        .flatten();
    let bridge = Bridge {
        token: bootstrap.token.clone(),
        assignment,
        checkpoint,
        resolved_skills,
        host_token: host_token.to_owned(),
        host,
        harness: options.harness,
        coordination,
        state: Arc::default(),
        attached: Arc::default(),
        inputs: inputs::InputLane::new(inputs, valid_until, shutdown),
        workspace: remote_workspace,
        mcp,
        mcp_lane: Arc::default(),
        artifact_checkout,
        artifact_inputs,
        artifact_capacity: Arc::new(Semaphore::new(1)),
        secrets,
        text: Arc::default(),
    };
    let stop_server = CancellationToken::new();
    let mut server = tokio::spawn(
        Server::builder()
            .add_service(
                HarnessServer::new(bridge.clone())
                    .max_decoding_message_size(MAX_CHECKPOINT_BYTES + MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_CHECKPOINT_BYTES + MAX_MESSAGE_BYTES),
            )
            .add_service(bridge.questions_service())
            .add_service(bridge.workstreams_service())
            .add_service(bridge.mailbox_service())
            .add_service(bridge.work_sessions_service())
            .add_service(bridge.tag_sessions_service())
            .add_service(bridge.schedules_service())
            .add_service(bridge.memory_service())
            .add_service(bridge.workspace_service())
            .add_service(bridge.mcp_service())
            .add_service(bridge.artifact_capture_service())
            .add_service(bridge.effects_service())
            .serve_with_incoming_shutdown(
                TcpListenerStream::new(listener),
                stop_server.clone().cancelled_owned(),
            ),
    );
    // A remote sandbox's harness also stops in time to leave the sandbox's cleanup margin.
    let attempt_ends = Instant::now() + options.attempt_timeout;
    let execution_ends = sandbox_execution_ends.map_or(attempt_ends, |ends| ends.min(attempt_ends));
    let provider = start_provider_proxy(options).await?;
    let result = supervise(
        options,
        &bridge,
        bootstrap,
        (valid_until, execution_ends),
        shutdown,
        (
            workspace,
            output_directory,
            native_memory
                .as_ref()
                .map(NativeMemory::working_directory)
                .as_deref(),
        ),
        (&processes, &egress_environment, provider.as_ref()),
    )
    .await;
    if let Some(provider) = provider {
        provider.stop().await;
    }
    bridge.inputs.close();
    if let Some(prepared) = native_memory {
        finish_native_memory(&bridge, prepared).await;
    }
    stop_server.cancel();
    if time::timeout(Duration::from_secs(2), &mut server)
        .await
        .is_err()
    {
        server.abort();
        let _ = server.await;
    }
    // A cancelled RPC can leave a blocking filesystem operation finishing in the
    // Host. Never finalize or discard its checkout until that operation stopped.
    let _artifact_idle = time::timeout(Duration::from_secs(5), bridge.artifact_capacity.acquire())
        .await
        .context("artifact filesystem operation did not stop")?
        .context("artifact filesystem lane is closed")?;
    result
}

/// An Attempt's copy of its Tag's native memory: from this host's store, or from the store on
/// the Tag's Volume when it names one.
enum NativeMemory {
    Host(crate::native_memory::Prepared),
    Volume(
        crate::native_memory_volume::Prepared,
        Box<crate::native_memory_volume::Access>,
    ),
}

impl NativeMemory {
    fn working_directory(&self) -> PathBuf {
        match self {
            Self::Host(prepared) => prepared.working_directory(),
            Self::Volume(prepared, _) => prepared.working_directory(),
        }
    }
}

/// The Attempt's copy of its Tag's native memory, when the Control Plane granted one and this
/// harness keeps one. Native memory is a convenience: a copy that cannot be made never stops
/// the turn.
async fn prepare_native_memory(
    options: &HostOptions,
    assignment: &Assignment,
    coordination: &CoordinationClients,
    host_token: &str,
) -> Option<NativeMemory> {
    // A remote Workspace keeps the Task's file and command tools in its sandbox, but the harness
    // and its memory folder stay on this host: nothing in the sandbox reaches the folder, and the
    // harness keeps its memories there with its own tools, which run here.
    let grant = assignment.native_memory.clone()?;
    let harness = crate::native_memory::harness_directory(options.harness)?;
    let task = assignment.task.as_ref()?;
    let state = options.state_directory.clone();
    let attempt = assignment.attempt_id.clone();
    if let Some(volume) = assignment.volume.clone() {
        // The store lives on the Tag's Volume, so any host that reaches the Volume uses it.
        let access = crate::native_memory_volume::Access {
            objects: coordination.transfers.volume_objects(),
            memory: coordination.memory.clone(),
            token: host_token.to_owned(),
            attempt: InspectAttemptRequest {
                task_id: task.task_id.clone(),
                attempt_id: attempt.clone(),
                lease_token: assignment.lease_token.clone(),
            },
            volume,
            volumes: coordination.volumes.clone(),
        };
        return match crate::native_memory_volume::Prepared::prepare(
            &access, &state, &attempt, &grant,
        )
        .await
        {
            Ok(prepared) => Some(NativeMemory::Volume(prepared, Box::new(access))),
            Err(error) => {
                crate::failures::note(
                    "Native memory could not be read from the Tag's Volume",
                    &error,
                );
                None
            }
        };
    }
    let tag = task.tag_id.clone();
    // The store lives in the host's artifact storage, which every lane shares, so any lane of
    // the host finds the Tag's memory; the Attempt's copy stays in this lane's state directory.
    // The live storage the host serves from, which `run` opened from `--artifact-directory`;
    // `options.artifact_source` is taken before any turn runs.
    let storage = coordination.artifact_source.as_ref()?.root().to_owned();
    match tokio::task::spawn_blocking(move || {
        crate::native_memory::Prepared::prepare((&storage, &state), &tag, harness, &attempt, &grant)
    })
    .await
    {
        Ok(Ok(prepared)) => Some(NativeMemory::Host(prepared)),
        Ok(Err(error)) => {
            crate::failures::note("Native memory could not be prepared", &error);
            None
        }
        Err(error) => {
            crate::failures::note("Native memory could not be prepared", &error);
            None
        }
    }
}

/// Merges the Attempt's native memory back and records what this host now holds.
async fn finish_native_memory(bridge: &Bridge, memory: NativeMemory) {
    let prepared = match memory {
        NativeMemory::Host(prepared) => prepared,
        // The store on the Volume records itself: moving its head is the record.
        NativeMemory::Volume(prepared, access) => {
            if let Err(error) = prepared.finish(&access).await {
                crate::failures::note(
                    "Native memory changes were not kept on the Tag's Volume",
                    &error,
                );
            }
            return;
        }
    };
    let summary = match tokio::task::spawn_blocking(move || prepared.finish()).await {
        Ok(Ok(summary)) => summary,
        Ok(Err(error)) => {
            crate::failures::note("Native memory changes were not kept", &error);
            return;
        }
        Err(error) => {
            crate::failures::note("Native memory changes were not kept", &error);
            return;
        }
    };
    let report = supertag_protocol::v2::ReportNativeMemoryRequest {
        attempt: Some(bridge.attempt()),
        revision: summary.revision,
        files: summary.files,
        bytes: summary.bytes,
        digest: summary.digest,
        reset_generation: summary.generation,
    };
    // The harness has stopped, so this goes straight out once, under the host's own credential;
    // a record lost here is replaced by the next turn's.
    let sent = async {
        let mut request = authenticated_request(report, &bridge.host_token, None)
            .map_err(|error| Status::internal(error.to_string()))?;
        request.set_timeout(Duration::from_secs(10));
        bridge
            .coordination
            .memory
            .clone()
            .report_native(request)
            .await
    }
    .await;
    if let Err(status) = sent {
        crate::failures::note("Native memory record was not sent", &status.message());
    }
}

/// The variable a harness adapter reads the provider proxy's URL from; Claude Code gets it as
/// `ANTHROPIC_BASE_URL`, OpenCode as its provider's `baseURL`.
const PROVIDER_PROXY_URL: &str = "SUPERTAG_PROVIDER_BASE_URL";
/// The Anthropic credentials Claude Code reads from its environment.
pub(crate) const ANTHROPIC_CREDENTIALS: [&str; 3] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

/// The origin a provider proxy forwards to for a provider, as OpenCode names it: only those
/// whose API SuperTag knows. Test builds may point it at a fixture.
fn provider_origin(provider: &str) -> Option<String> {
    let (fixture, origin) = match provider {
        "anthropic" => (
            "SUPERTAG_TEST_ANTHROPIC_ORIGIN",
            "https://api.anthropic.com",
        ),
        "openai" => ("SUPERTAG_TEST_OPENAI_ORIGIN", "https://api.openai.com"),
        _ => return None,
    };
    #[cfg(feature = "test-fixtures")]
    if let Ok(origin) = std::env::var(fixture) {
        return Some(origin);
    }
    let _ = fixture;
    Some(origin.to_owned())
}

/// A credential the host holds (from its credentials file or environment), when it holds one.
fn environment_credential(variable: &str) -> Option<crate::provider_proxy::Swap> {
    crate::provider_variable(variable)
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.is_empty())
        .map(|value| crate::provider_proxy::Swap::new(variable, value))
}

/// OpenCode's API key for `provider` from the auth file the host gives its adapter (its
/// `--auth-file`, from the host's `--opencode-auth-file`): `{ PROVIDER: { "type": "api", "key": KEY } }`. A sign-in of another
/// kind can't go behind the proxy.
fn opencode_file_key(options: &HostOptions, provider: &str) -> Option<String> {
    let path = options
        .adapter_args
        .windows(2)
        .find(|pair| pair[0] == "--auth-file")
        .map(|pair| std::path::PathBuf::from(&pair[1]))?;
    let file: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let entry = file.get(provider)?;
    (entry.get("type")?.as_str()? == "api")
        .then(|| entry.get("key")?.as_str().map(str::to_owned))
        .flatten()
        .filter(|key| !key.is_empty())
}

/// What allowing a harness to run commands without a sandbox means, for `supertag init` and a
/// Worker Host that starts with `allow-unsandboxed-commands`.
pub fn unsandboxed_caveat(name: &str) -> String {
    format!(
        "{name} runs commands without a sandbox, as this host's user: they can read and change anything that user can, including its files, the env_file, and harness sign-ins, and reach the network. Give its Tags only trusted work. SuperTag keeps model keys out of those commands' environment, which stops accidental leaks but is not a boundary. For one, run the host with environment: local-vm on Docker."
    )
}

/// Why this unsandboxed host's model key can't go behind the provider proxy, so the commands its
/// harness runs can reach it; `None` when it can, or when the host runs no command unsandboxed.
pub(crate) fn unproxied_key_warning(options: &HostOptions) -> Option<String> {
    if !options.execution_profile.allow_unsandboxed_commands {
        return None;
    }
    match options.harness {
        HarnessKind::ClaudeCode
            if !ANTHROPIC_CREDENTIALS
                .iter()
                .any(|&variable| environment_credential(variable).is_some()) =>
        {
            Some("Claude Code uses its own sign-in on this host, which the commands it runs without a sandbox can read. Set ANTHROPIC_API_KEY in the host's env_file (default ~/.supertag/.env) to keep the key in the Worker Host.".to_owned())
        }
        HarnessKind::Opencode => {
            let model = options.provider_model.as_deref()?;
            let provider = crate::credentials::validate_opencode_model(model).ok()?;
            let variable = *crate::provider_environment_for(HarnessKind::Opencode, Some(model))
                .ok()?
                .first()?;
            let held = provider_origin(provider).is_some()
                && (environment_credential(variable).is_some()
                    || opencode_file_key(options, provider).is_some());
            (!held).then(|| format!("OpenCode's {provider} sign-in on this host can't be kept in the Worker Host, so the commands it runs without a sandbox can read it. SuperTag keeps an anthropic or openai API key there, from {variable} in the host's env_file or an api key in the OpenCode auth file."))
        }
        // The Cursor SDK takes its backend from CURSOR_BACKEND_URL, but trades the API key for an
        // access token it then sends itself, and the backend can switch it to HTTP/2
        // bidirectional streams, which the provider proxy doesn't carry. So the adapter holds
        // the key, and commands it runs leave it out of their environment but can still read
        // the adapter's.
        HarnessKind::Cursor => Some("Cursor's API key can't be kept in the Worker Host: the Cursor adapter holds CURSOR_API_KEY, and the commands it runs without a sandbox, as the same user, can read it from the adapter process. Use environment: local-vm to keep the key out of their reach.".to_owned()),
        _ => None,
    }
}

/// On a host that runs commands unsandboxed, a Claude Code or OpenCode Attempt's model key stays
/// in this process: the harness talks to its provider through a proxy that holds it (see
/// `provider_proxy`). `None` elsewhere, and when the host has no key it can hold (a sign-in kept
/// in the macOS Keychain, an OpenCode OAuth sign-in, or a provider SuperTag doesn't proxy), which
/// the harness then reads itself.
async fn start_provider_proxy(
    options: &HostOptions,
) -> Result<Option<crate::provider_proxy::ProviderProxy>> {
    if !options.execution_profile.allow_unsandboxed_commands {
        return Ok(None);
    }
    let (origin, swaps) = match options.harness {
        HarnessKind::ClaudeCode => (
            provider_origin("anthropic"),
            ANTHROPIC_CREDENTIALS
                .iter()
                .filter_map(|&variable| environment_credential(variable))
                .collect::<Vec<_>>(),
        ),
        HarnessKind::Opencode => {
            let Some(model) = options.provider_model.as_deref() else {
                return Ok(None);
            };
            let Some(&variable) =
                crate::provider_environment_for(HarnessKind::Opencode, Some(model))?.first()
            else {
                return Ok(None);
            };
            let provider = crate::credentials::validate_opencode_model(model)?;
            let swap = environment_credential(variable).or_else(|| {
                opencode_file_key(options, provider)
                    .map(|key| crate::provider_proxy::Swap::new(variable, key))
            });
            (provider_origin(provider), swap.into_iter().collect())
        }
        _ => return Ok(None),
    };
    let Some(origin) = origin else {
        return Ok(None);
    };
    if swaps.is_empty() {
        return Ok(None);
    }
    crate::provider_proxy::ProviderProxy::start(&origin, swaps)
        .await
        .map(Some)
}

async fn supervise(
    options: &HostOptions,
    bridge: &Bridge,
    bootstrap: AdapterBootstrap,
    (valid_until, execution_ends): (Instant, Instant),
    shutdown: &CancellationToken,
    (workspace, output_directory, native_memory): (Option<&Path>, Option<&Path>, Option<&Path>),
    (processes, egress_environment, provider): (
        &crate::journal::Processes,
        &[(String, std::ffi::OsString)],
        Option<&crate::provider_proxy::ProviderProxy>,
    ),
) -> Result<HarnessCompleteRequest> {
    if shutdown.is_cancelled() {
        return Ok(not_launched(bridge, "Worker Host is shutting down"));
    }
    if Instant::now() >= valid_until {
        return Ok(not_launched(
            bridge,
            "Execution authority expired before adapter launch",
        ));
    }
    // Sample the shared clock first so the deadline sent to the guardian is
    // no later than the remaining lifetime observed by this process.
    let now_ns = monotonic_now_ns()?;
    let remaining_ns = u64::try_from(
        valid_until
            .saturating_duration_since(Instant::now())
            .as_nanos(),
    )?;
    let launch_deadline = now_ns
        .checked_add(remaining_ns)
        .context("adapter launch deadline overflow")?;
    let mut command = Command::new(&options.adapter_guardian);
    command
        .args(["__adapter-guardian", "--adapter"])
        .arg(&options.adapter)
        .arg("--")
        .args(&options.adapter_args)
        .env_clear()
        .envs(
            ["PATH", "TMPDIR", "LANG"]
                .into_iter()
                .filter_map(|name| std::env::var_os(name).map(|value| (OsStr::new(name), value))),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    if let Some(workspace) = workspace {
        command
            .current_dir(workspace)
            .env(crate::WORKSPACE_DIRECTORY, workspace);
    }
    if let Some(directory) = output_directory {
        command.env(crate::task_outputs::OUTPUT_DIRECTORY, directory);
    }
    command.envs(egress_environment.iter().map(|(name, value)| (name, value)));
    if let Some(directory) = native_memory {
        command.env(crate::native_memory::DIRECTORY, directory);
    }
    command.env(
        crate::guardian::ADAPTER_SCRATCH_PARENT,
        options
            .state_directory
            .canonicalize()
            .context("resolve private Worker Host state")?,
    );
    command.envs(
        crate::provider_environment_for(options.harness, options.provider_model.as_deref())?
            .iter()
            .filter_map(|&name| {
                crate::provider_variable(name).map(|value| (OsStr::new(name), value))
            }),
    );
    // Behind the provider proxy the adapter gets placeholders and the proxy's URL, never the key.
    if let Some(provider) = provider {
        for (variable, placeholder) in provider.placeholders() {
            command.env(variable, placeholder);
        }
        command.env(PROVIDER_PROXY_URL, provider.base_url());
    }
    // Record the spawn before it happens, so a host killed at any point leaves either no
    // adapter or a record a restart can check.
    let pending = processes.prepare()?;
    let spawned = command.spawn();
    pending.record(spawned.as_ref().ok().and_then(Child::id))?;
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            return Ok(not_launched(
                bridge,
                &format!(
                    "Harness adapter could not start: {}",
                    std::io::Error::from(error.kind())
                ),
            ));
        }
    };
    let group = child.id().context("adapter process has no PID")?;
    let diagnostics = child
        .stderr
        .take()
        .map(|pipe| tokio::spawn(stderr_tail(pipe)));
    let outcome = time::timeout_at(execution_ends, async {
        let mut input = child
            .stdin
            .take()
            .context("adapter bootstrap pipe is missing")?;
        let payload = bootstrap.encode_to_vec();
        ensure!(
            payload.len() <= MAX_BOOTSTRAP_BYTES,
            "adapter bootstrap exceeds size limit"
        );
        let write_bootstrap = async {
            input.write_all(&(payload.len() as u32).to_le_bytes()).await?;
            input.write_all(&launch_deadline.to_le_bytes()).await?;
            input.write_all(&payload).await
        };
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => return Err(anyhow!("Worker Host is shutting down")),
            _ = time::sleep_until(valid_until) => return Err(anyhow!("execution authority expired during bootstrap")),
            written = write_bootstrap => written?,
        }
        // Keep the pipe open while monitoring. It closes on cancellation,
        // deadline, or Worker Host death and wakes the guardian.
        let outcome = monitor(&mut child, bridge, valid_until, shutdown).await;
        drop(input);
        outcome
    })
    .await;
    bridge.inputs.close();
    if child.try_wait()?.is_none() {
        // Give the guardian time to reap the adapter before forcing down the group.
        let _ = time::timeout(
            crate::guardian::ADAPTER_STOP_GRACE + Duration::from_millis(250),
            child.wait(),
        )
        .await;
    }
    let survivors = signal_group(group, libc::SIGKILL).await?;
    time::timeout(Duration::from_secs(2), async {
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        child.wait().await?;
        while signal_group(group, 0).await? {
            time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("adapter process group did not stop")??;
    let reported = bridge.state.lock().await.outcome.clone();
    let complete = match outcome {
        // An adapter that already reported a failure may have stopped its harness abruptly and
        // left processes the guardian then stopped. Its own failure is the better explanation.
        Ok(Ok(_)) if reported.as_ref().is_some_and(|outcome| !outcome.succeeded) => {
            reported.unwrap_or_else(|| failed("Harness adapter exited without an outcome"))
        }
        Ok(Ok(status)) if survivors || !status.success() => {
            failed("Harness adapter exited unsuccessfully or left running descendants")
        }
        Ok(Ok(_)) => {
            reported.unwrap_or_else(|| failed("Harness adapter exited without an outcome"))
        }
        Ok(Err(error)) => {
            crate::failures::note("Harness execution was interrupted", &error);
            failed("Harness execution was interrupted")
        }
        Err(_) => failed("Harness execution timed out"),
    };
    match diagnostics {
        // Only a failure is explained. The process group is gone, so the pipe is closed unless
        // a process that left the group still holds it; wait for it briefly, never for success.
        Some(reader) if !complete.succeeded => {
            let stderr = time::timeout(Duration::from_secs(1), reader)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            report_diagnostics(bridge, &complete.result, &stderr);
        }
        Some(reader) => reader.abort(),
        None if !complete.succeeded => report_diagnostics(bridge, &complete.result, &[]),
        None => {}
    }
    Ok(complete)
}

/// The most of an adapter's standard error a failed Attempt reports in the Worker Host log.
const MAX_ADAPTER_DIAGNOSTICS: usize = 8 * 1024;

/// Reads an adapter's standard error to its end, keeping only the last
/// [`MAX_ADAPTER_DIAGNOSTICS`] bytes, so a chatty adapter costs bounded memory.
async fn stderr_tail(mut pipe: tokio::process::ChildStderr) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut tail = Vec::with_capacity(MAX_ADAPTER_DIAGNOSTICS);
    let mut chunk = [0_u8; 4096];
    let mut cut = false;
    while let Ok(read) = pipe.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        tail.extend_from_slice(&chunk[..read]);
        if tail.len() > MAX_ADAPTER_DIAGNOSTICS {
            tail.drain(..tail.len() - MAX_ADAPTER_DIAGNOSTICS);
            cut = true;
        }
    }
    complete_lines(tail, cut)
}

/// Drops a first line that keeping the tail cut short: it could begin inside a secret that
/// redaction can then no longer recognize.
fn complete_lines(mut tail: Vec<u8>, cut: bool) -> Vec<u8> {
    if cut {
        let start = tail
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or(tail.len(), |at| at + 1);
        tail.drain(..start);
    }
    tail
}

/// Explains a failed Attempt in the Worker Host log with the adapter's own last words,
/// redacted like every other harness text that leaves the adapter.
fn report_diagnostics(bridge: &Bridge, result: &str, stderr: &[u8]) {
    use supertag_protocol::terminal_text::warn;
    warn(&format!(
        "Task {} Attempt {} failed: {}",
        bridge.task_id(),
        bridge.assignment.attempt_id,
        bridge.redact(result),
    ));
    let text = bridge.redact(String::from_utf8_lossy(stderr).trim());
    if text.is_empty() {
        warn("  The harness adapter wrote nothing to standard error.");
        return;
    }
    warn("  Harness adapter standard error (its last lines):");
    for line in text.lines() {
        warn(&format!("  | {line}"));
    }
}

/// An Attempt whose adapter never ran fails with `reason`, named in the Worker Host log.
fn not_launched(bridge: &Bridge, reason: &str) -> HarnessCompleteRequest {
    supertag_protocol::terminal_text::warn(&format!(
        "Task {} Attempt {} failed before its harness adapter ran: {reason}",
        bridge.task_id(),
        bridge.assignment.attempt_id,
    ));
    failed(reason)
}

/// The secrets of this Worker Host's environment, plus `credentials` it holds itself.
pub(crate) fn host_secrets(credentials: &[&str]) -> Vec<SensitiveValue> {
    let environment = std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect::<Vec<_>>();
    let mut secrets = sensitive_environment_values(
        environment
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    );
    secrets.extend(
        credentials
            .iter()
            .map(|credential| SensitiveValue::High((*credential).to_owned())),
    );
    unique_sensitive_values(secrets)
}

pub(crate) fn failed(message: &str) -> HarnessCompleteRequest {
    HarnessCompleteRequest {
        result: message.into(),
        succeeded: false,
        objective_signal: 0,
        checkpoint: None,
        waiting_approval_ids: vec![],
        quiet: false,
    }
}

async fn monitor(
    child: &mut Child,
    bridge: &Bridge,
    mut valid_until: Instant,
    shutdown: &CancellationToken,
) -> Result<ExitStatus> {
    let status = tokio::select! {
        biased;
        _ = shutdown.cancelled() => return Err(anyhow!("Worker Host is shutting down")),
        result = monitor_authority(bridge, &mut valid_until) => {
            result?;
            unreachable!("authority monitoring ends only on rejection")
        },
        status = child.wait() => status?,
    };
    ensure!(!shutdown.is_cancelled(), "Worker Host is shutting down");
    ensure!(
        Instant::now() < valid_until,
        "execution authority expired before adapter exit was observed"
    );
    Ok(status)
}

async fn monitor_authority(bridge: &Bridge, valid_until: &mut Instant) -> Result<()> {
    const POLL: Duration = Duration::from_millis(250);
    let mut host = bridge.host.clone();
    let mut poll_at = Instant::now();
    let mut renew_at = renewal_time(*valid_until);
    loop {
        time::sleep_until(poll_at.min(renew_at).min(*valid_until)).await;
        let sent = Instant::now();
        ensure!(sent < *valid_until, "execution authority expired");
        let mut request = authenticated_request(bridge.attempt(), &bridge.host_token, None)?;
        request.set_timeout(Duration::from_secs(2));
        let observed = if sent >= renew_at {
            let renewed = time::timeout_at(*valid_until, host.renew_attempt(request))
                .await
                .context("execution authority expired during renewal")?;
            ensure!(
                Instant::now() < *valid_until,
                "execution authority expired during renewal"
            );
            match renewed {
                Ok(response) => {
                    let authority = response.into_inner();
                    let deadline = sent
                        .checked_add(Duration::from_millis(authority.valid_for_ms))
                        .context("invalid execution authority duration")?;
                    ensure!(
                        deadline > Instant::now(),
                        "Control Plane ended execution authority"
                    );
                    *valid_until = deadline;
                    renew_at = renewal_time(deadline);
                    Ok(authority.task.context("execution authority has no Task")?)
                }
                Err(error) => {
                    renew_at = Instant::now() + POLL;
                    Err(error)
                }
            }
        } else {
            time::timeout_at(*valid_until, host.inspect_attempt(request))
                .await
                .context("execution authority expired during inspection")?
                .map(Response::into_inner)
        };
        match observed {
            Ok(task) => {
                ensure!(
                    task.task_id == bridge.task_id()
                        && task.attempt_id.as_deref()
                            == Some(bridge.assignment.attempt_id.as_str())
                        && task.state() == TaskState::Running,
                    "Control Plane ended the Task Attempt"
                );
                bridge.inputs.set_deadline(*valid_until);
            }
            Err(error) if crate::retryable(&error) => {}
            Err(error) => return Err(error.into()),
        }
        poll_at = Instant::now() + POLL;
    }
}

fn renewal_time(valid_until: Instant) -> Instant {
    let now = Instant::now();
    now + (valid_until.saturating_duration_since(now) / 3).min(Duration::from_secs(5))
}

async fn signal_group(group: u32, signal: i32) -> Result<bool> {
    let group = i32::try_from(group).context("adapter process group is out of range")?;
    ensure!(group > 0, "invalid adapter process group");
    // Darwin answers EPERM instead of ESRCH while a group holds only zombies that their
    // reaper has not collected yet, as when a harness process was killed with its guardian.
    let mut zombie_retries = if cfg!(target_os = "macos") { 100 } else { 0 };
    loop {
        // The child was launched as leader of a dedicated Unix process group.
        let result = unsafe { libc::kill(-group, signal) };
        if result == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => return Ok(false),
            Some(libc::EPERM) if zombie_retries > 0 => {
                zombie_retries -= 1;
                time::sleep(Duration::from_millis(10)).await;
            }
            _ => {
                return Err(error)
                    .with_context(|| format!("signal {signal} to adapter process group {group}"));
            }
        }
    }
}

/// The largest event text the Control Plane accepts.
const MAX_EVENT_TEXT_BYTES: usize = 16_384;
/// The largest result a harness may propose.
const MAX_RESULT_BYTES: usize = 262_144;

/// `text` cut at a character boundary to at most `limit` bytes.
fn bounded(mut text: String, limit: usize) -> String {
    if text.len() > limit {
        let mut end = limit;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}
