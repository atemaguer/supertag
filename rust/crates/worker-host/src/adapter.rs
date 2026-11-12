mod inputs;
mod questions;
mod work_sessions;
mod workstreams;

use std::{
    collections::HashSet,
    ffi::OsStr,
    io,
    path::Path,
    process::{ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use prost::Message;
use supertag_protocol::{
    MAX_CHECKPOINT_BYTES, MAX_MESSAGE_BYTES, authenticated_request, matches_bearer,
    v2::{
        AdapterBootstrap, AppendEventRequest, Assignment, HarnessAttachRequest,
        HarnessCompleteRequest, HarnessCompleteResponse, HarnessPublishRequest, HarnessRun,
        HarnessSettleLiveInputRequest, HarnessTakeLiveInputRequest, HarnessUsageRequest,
        InspectAttemptRequest, LiveInput, ObjectiveSignal, ReportAttemptUsageRequest,
        ReportAttemptUsageResponse, ResolvedSkill, SessionCheckpoint, TakeInputResponse, TaskEvent,
        TaskState,
        harness_server::{Harness, HarnessServer},
    },
    validate_checkpoint_reference,
};
use tokio::{
    io::AsyncWriteExt,
    net::TcpListener,
    process::{Child, Command},
    sync::Mutex,
    time::{self, Instant},
};
use tokio_stream::wrappers::TcpListenerStream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status, transport::Server};
use uuid::Uuid;

use crate::{
    CoordinationClients, HostOptions, RegisteredHost, RegisteredInputs,
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
    coordination: CoordinationClients,
    state: Arc<Mutex<RunState>>,
    attached: Arc<AtomicBool>,
    inputs: inputs::InputLane,
}

#[derive(Default)]
struct RunState {
    outcome: Option<HarnessCompleteRequest>,
    observed_approvals: HashSet<String>,
}

impl Bridge {
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
}

#[tonic::async_trait]
impl Harness for Bridge {
    async fn attach(
        &self,
        request: Request<HarnessAttachRequest>,
    ) -> Result<Response<HarnessRun>, Status> {
        self.authenticate(&request)?;
        let mut upstream = authenticated_request(self.attempt(), &self.host_token, None)?;
        upstream.set_timeout(Duration::from_secs(5));
        let capabilities = self
            .host
            .clone()
            .get_attempt_capabilities(upstream)
            .await?
            .into_inner();
        self.attached.store(true, Ordering::Release);
        Ok(Response::new(HarnessRun {
            task: self.assignment.task.clone(),
            attempt_id: self.assignment.attempt_id.clone(),
            checkpoint: self.checkpoint.clone(),
            may_ask_objective_question: capabilities.may_ask_objective_question,
            coordination: Some(capabilities),
            resolved_skills: self.resolved_skills.clone(),
        }))
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
        let mut upstream = authenticated_request(
            AppendEventRequest {
                task_id: self.task_id().into(),
                attempt_id: self.assignment.attempt_id.clone(),
                lease_token: self.assignment.lease_token.clone(),
                sequence: event.sequence,
                text: event.text,
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        let event = self.host.clone().append_event(upstream).await?;
        drop(state);
        Ok(event)
    }

    async fn report_usage(
        &self,
        request: Request<HarnessUsageRequest>,
    ) -> Result<Response<ReportAttemptUsageResponse>, Status> {
        self.authenticate(&request)?;
        let state = self.state.lock().await;
        if !self.attached.load(Ordering::Acquire) || state.outcome.is_some() {
            return Err(Status::failed_precondition(
                "execution is not accepting usage",
            ));
        }
        let usage = request.into_inner();
        if usage.native_usage.is_none() {
            return Err(Status::invalid_argument("native token usage required"));
        }
        let mut upstream = authenticated_request(
            ReportAttemptUsageRequest {
                attempt: Some(self.attempt()),
                sequence: usage.sequence,
                amount_minor: None,
                currency: None,
                estimated: false,
                native_usage: usage.native_usage,
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        let response = self.host.clone().report_attempt_usage(upstream).await;
        drop(state);
        response
    }

    async fn complete(
        &self,
        request: Request<HarnessCompleteRequest>,
    ) -> Result<Response<HarnessCompleteResponse>, Status> {
        self.authenticate(&request)?;
        let mut state = self.state.lock().await;
        if !self.attached.load(Ordering::Acquire) {
            return Err(Status::failed_precondition(
                "adapter must attach before proposing a result",
            ));
        }
        let outcome = request.into_inner();
        if outcome.result.len() > 262_144
            || outcome.result.contains('\0')
            || ObjectiveSignal::try_from(outcome.objective_signal).is_err()
            || (!outcome.succeeded && outcome.objective_signal != ObjectiveSignal::Progress as i32)
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

pub(crate) async fn execute(
    options: &HostOptions,
    assignment: Assignment,
    (checkpoint, workspace, resolved_skills): (
        Option<SessionCheckpoint>,
        Option<&Path>,
        Vec<ResolvedSkill>,
    ),
    (host, inputs, coordination): (RegisteredHost, RegisteredInputs, CoordinationClients),
    host_token: &str,
    valid_until: Instant,
    shutdown: &CancellationToken,
) -> Result<HarnessCompleteRequest> {
    ensure!(assignment.task.is_some(), "assignment is missing its Task");
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let bootstrap = AdapterBootstrap {
        endpoint: format!("http://{}", listener.local_addr()?),
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
    };
    let bridge = Bridge {
        token: bootstrap.token.clone(),
        assignment,
        checkpoint,
        resolved_skills,
        host_token: host_token.to_owned(),
        host,
        coordination,
        state: Arc::default(),
        attached: Arc::default(),
        inputs: inputs::InputLane::new(inputs, valid_until, shutdown),
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
            .serve_with_incoming_shutdown(
                TcpListenerStream::new(listener),
                stop_server.clone().cancelled_owned(),
            ),
    );
    let result = supervise(
        options,
        &bridge,
        bootstrap,
        valid_until,
        shutdown,
        workspace,
    )
    .await;
    bridge.inputs.close();
    stop_server.cancel();
    if time::timeout(Duration::from_secs(2), &mut server)
        .await
        .is_err()
    {
        server.abort();
        let _ = server.await;
    }
    result
}

async fn supervise(
    options: &HostOptions,
    bridge: &Bridge,
    bootstrap: AdapterBootstrap,
    valid_until: Instant,
    shutdown: &CancellationToken,
    workspace: Option<&Path>,
) -> Result<HarnessCompleteRequest> {
    if shutdown.is_cancelled() {
        return Ok(failed("Worker Host is shutting down"));
    }
    if Instant::now() >= valid_until {
        return Ok(failed("Execution authority expired before adapter launch"));
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
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true);
    if let Some(workspace) = workspace {
        command
            .current_dir(workspace)
            .env(crate::WORKSPACE_DIRECTORY, workspace);
    }
    command.env(
        crate::guardian::ADAPTER_SCRATCH_PARENT,
        options
            .state_directory
            .canonicalize()
            .context("resolve private Worker Host state")?,
    );
    command.envs(
        crate::provider_environment(options.harness)
            .iter()
            .filter_map(|&name| std::env::var_os(name).map(|value| (OsStr::new(name), value))),
    );
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return Ok(failed("Harness adapter could not start")),
    };
    let group = child.id().context("adapter process has no PID")?;
    let outcome = time::timeout(options.attempt_timeout, async {
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
        let _ = time::timeout(Duration::from_millis(500), child.wait()).await;
    }
    let survivors = signal_group(group, libc::SIGKILL)?;
    time::timeout(Duration::from_secs(2), async {
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        child.wait().await?;
        while signal_group(group, 0)? {
            time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("adapter process group did not stop")??;
    let status = match outcome {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => return Ok(failed("Harness execution was interrupted")),
        Err(_) => return Ok(failed("Harness execution timed out")),
    };
    if survivors || !status.success() {
        return Ok(failed(
            "Harness adapter exited unsuccessfully or left running descendants",
        ));
    }
    Ok(bridge
        .state
        .lock()
        .await
        .outcome
        .clone()
        .unwrap_or_else(|| failed("Harness adapter exited without an outcome")))
}

pub(crate) fn failed(message: &str) -> HarnessCompleteRequest {
    HarnessCompleteRequest {
        result: message.into(),
        succeeded: false,
        objective_signal: 0,
        checkpoint: None,
        waiting_approval_ids: vec![],
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

fn signal_group(group: u32, signal: i32) -> Result<bool> {
    let group = i32::try_from(group).context("adapter process group is out of range")?;
    ensure!(group > 0, "invalid adapter process group");
    // The child was launched as leader of a dedicated Unix process group.
    let result = unsafe { libc::kill(-group, signal) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(error.into())
}
