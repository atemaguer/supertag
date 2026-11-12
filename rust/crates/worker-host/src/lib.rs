mod adapter;
mod checkpoints;
mod enrollment;
mod guardian;
mod journal;
mod readiness;
mod workspaces;

pub use enrollment::enroll;
pub use guardian::{ADAPTER_STATE_DIRECTORY, guard_adapter};
pub use workspaces::{WORKSPACE_DIRECTORY, WorkspaceMapping};

use std::{ffi::OsString, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use journal::{Attempt, Entry, Journal};
use supertag_protocol::{
    HOST_GENERATION_HEADER, MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        Assignment, ClaimTaskRequest, FinishTaskRequest, HarnessCompleteRequest, HarnessKind,
        InspectAttemptRequest, RegisterHostRequest, StartTaskRequest, Task, TaskState,
        attempt_inputs_client::AttemptInputsClient,
        attempt_workstreams_client::AttemptWorkstreamsClient, worker_host_client::WorkerHostClient,
    },
};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use tonic::{
    Code, Request, Status,
    metadata::{Ascii, MetadataValue},
    service::{Interceptor, interceptor::InterceptedService},
    transport::{Channel, Endpoint},
};
use uuid::Uuid;

/// Model provider environment accepted by each first-party adapter.
pub fn provider_environment(harness: HarnessKind) -> &'static [&'static str] {
    match harness {
        HarnessKind::Codex => &["HOME", "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"],
        HarnessKind::ClaudeCode => &[
            "HOME",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        ],
        HarnessKind::OpenaiAgents => &["OPENAI_API_KEY"],
        HarnessKind::Unspecified => &[],
    }
}

pub struct HostOptions {
    pub gateway: Endpoint,
    pub token: Option<String>,
    pub state_directory: PathBuf,
    pub adapter_guardian: PathBuf,
    pub adapter: PathBuf,
    pub adapter_args: Vec<OsString>,
    pub harness: HarnessKind,
    pub attempt_timeout: Duration,
    pub wait_for_recovery: bool,
    pub once: bool,
    pub workspace: Option<WorkspaceMapping>,
}

#[derive(Clone)]
pub(crate) struct HostHeaders(MetadataValue<Ascii>);

impl Interceptor for HostHeaders {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, Status> {
        request
            .metadata_mut()
            .insert(HOST_GENERATION_HEADER, self.0.clone());
        Ok(request)
    }
}

pub(crate) type RegisteredHost = WorkerHostClient<InterceptedService<Channel, HostHeaders>>;
pub(crate) type RegisteredInputs = AttemptInputsClient<InterceptedService<Channel, HostHeaders>>;
pub(crate) type RegisteredWorkstreams =
    AttemptWorkstreamsClient<InterceptedService<Channel, HostHeaders>>;

impl Attempt {
    fn from_assignment(assignment: Assignment) -> Result<Self> {
        let task = assignment.task.context("assignment has no Task")?;
        ensure!(
            task.attempt_id.as_deref() == Some(assignment.attempt_id.as_str()),
            "assignment has mismatched Attempt identity"
        );
        Ok(Self {
            task_id: task.task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
        })
    }

    fn inspect(&self) -> InspectAttemptRequest {
        InspectAttemptRequest {
            task_id: self.task_id.clone(),
            attempt_id: self.attempt_id.clone(),
            lease_token: self.lease_token.clone(),
        }
    }
}

pub async fn run(
    options: HostOptions,
    shutdown: CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    ensure!(
        !options.attempt_timeout.is_zero(),
        "attempt timeout must be positive"
    );
    let shutdown = shutdown.child_token();
    let journal = Arc::new(Journal::open(&options.state_directory)?);
    let workspaces =
        workspaces::Workspaces::new(&options.state_directory, options.workspace.clone())?;
    // Terminal proof is durable; finishing local cleanup needs neither the source
    // repository nor a new network registration.
    if let Some(Entry::Terminal { prepared, .. }) = journal.load()? {
        cleanup_terminal(&journal, &workspaces, prepared.as_deref())?;
        if options.once {
            ready();
            return Ok(());
        }
    }
    let token = match &options.token {
        Some(token) if !token.is_empty() => token.clone(),
        Some(_) => bail!("Worker Host credential is empty"),
        None => enrollment::host_token(&journal, &options.gateway)?,
    };
    let incarnation_id = journal.incarnation()?;
    let channel = options.gateway.clone().connect_lazy();
    let mut registration = WorkerHostClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let generation = loop {
        if shutdown.is_cancelled() {
            return Ok(());
        }
        let response = registration
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
                break host.generation;
            }
            Err(error) if retryable(&error) => wait_for_work(&shutdown).await,
            Err(error) => return Err(error.into()),
        }
    };
    let headers = HostHeaders(generation.to_string().parse()?);
    let inputs = AttemptInputsClient::with_interceptor(
        options.gateway.clone().connect_lazy(),
        headers.clone(),
    )
    .max_decoding_message_size(MAX_MESSAGE_BYTES)
    .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let workstream_client =
        AttemptWorkstreamsClient::with_interceptor(channel.clone(), headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let transfers = checkpoints::Transfers::new(channel.clone(), headers.clone());
    let mut host = WorkerHostClient::with_interceptor(channel, headers)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let presence = readiness::Presence::start(
        journal.clone(),
        host.clone(),
        token.clone(),
        options.harness as i32,
        workspaces.ids(),
        shutdown.clone(),
    );
    let outcome = async {
    let mut ready = Some(ready);
    while !shutdown.is_cancelled() {
        let entry = match journal.load()? {
            Some(entry) => entry,
            None => {
                let entry = Entry::Claim {
                    operation_id: Uuid::new_v4().to_string(),
                };
                journal.save(&entry)?;
                entry
            }
        };
        presence.set(match &entry {
            Entry::Claim { .. } => readiness::State::Ready,
            Entry::Executing { .. } => readiness::State::Recovery,
            _ => readiness::State::Busy,
        });
        match entry {
            Entry::Claim { operation_id } => {
                let response = host
                    .claim_task(request(
                        ClaimTaskRequest {
                            operation_id,
                            workspace_ids: workspaces.ids(),
                            harness_kind: options.harness as i32,
                        },
                        &token,
                    )?)
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
                    journal.save(&Entry::Starting {
                        attempt: Attempt::from_assignment(assignment)?,
                    })?;
                } else {
                    journal.clear()?;
                    if options.once {
                        return Ok(());
                    }
                    wait_for_work(&shutdown).await;
                }
            }
            Entry::Starting { attempt } => {
                run_assignment(
                    &options,
                    &journal,
                    &workspaces,
                    (&mut host, &inputs, &workstream_client, &transfers, &token),
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
                match resolved(&mut host, &attempt, &token).await {
                    Ok(true) => journal.save(&Entry::Terminal { attempt, prepared })?,
                    Ok(false) if options.wait_for_recovery => {
                        if let Some(ready) = ready.take() {
                            ready();
                            eprintln!(
                                "Task {} Attempt {} needs recovery before this host can claim work",
                                attempt.task_id, attempt.attempt_id
                            );
                        }
                        wait_for_work(&shutdown).await;
                    }
                    Ok(false) => bail!(
                        "Task {} Attempt {} needs recovery before this host can claim work",
                        attempt.task_id,
                        attempt.attempt_id
                    ),
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
            } => {
                // This stage is recorded only after the adapter process group was reaped.
                // Exact finalization can safely resume after a Host restart.
                let cancellation = shutdown.child_token();
                let finalization = with_authority(
                    &mut host,
                    &attempt,
                    &token,
                    &shutdown,
                    &cancellation,
                    async {
                        workspaces
                            .finalize(&workspace, &result, succeeded, &cancellation)
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
            } => {
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
                    Ok(response) => ensure!(
                        matches!(
                            response.get_ref().state(),
                            TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled
                        ),
                        "Finish returned a nonterminal Task"
                    ),
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
            Entry::Terminal { prepared, .. } => {
                cleanup_terminal(&journal, &workspaces, prepared.as_deref())?;
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
    let stopped = presence.stop().await;
    outcome.and(stopped)
}

fn cleanup_terminal(
    journal: &Journal,
    workspaces: &workspaces::Workspaces,
    prepared: Option<&workspaces::PreparedWorkspace>,
) -> Result<()> {
    if let Some(prepared) = prepared {
        workspaces.discard(prepared)?;
    }
    journal.clear()
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

async fn run_assignment(
    options: &HostOptions,
    journal: &Journal,
    workspaces: &workspaces::Workspaces,
    connection: (
        &mut RegisteredHost,
        &RegisteredInputs,
        &RegisteredWorkstreams,
        &checkpoints::Transfers,
        &str,
    ),
    attempt: Attempt,
    shutdown: &CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    let (host, inputs, workstream_client, transfers, token) = connection;
    // Starting is durable before requesting authority and never records a launch.
    // A lost start response can therefore be retried using this exact Attempt.
    let start = host
        .start_task(request(
            StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
            token,
        )?)
        .await;
    let task = match start {
        Ok(response) => response.into_inner(),
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
                Err(error) if lost_ownership(&error) => return journal.clear(),
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    };
    ensure_attempt(&task, &attempt)?;
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
        Err(error) if lost_ownership(&error) => return journal.clear(),
        Err(error) => return Err(error.into()),
    };
    ready();
    let task = authority.task.context("execution authority has no Task")?;
    ensure_attempt(&task, &attempt)?;
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
    let (workspace, valid_until) = match prepared {
        Ok(prepared) => prepared,
        Err(error) if retryable(&error) && !shutdown.is_cancelled() => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Err(_) => {
            return save_finish(
                journal,
                attempt,
                adapter::failed("Task workspace could not be prepared safely"),
            );
        }
    };
    let assignment = Assignment {
        task: Some(task),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
    };
    journal.save(&Entry::Executing {
        attempt: attempt.clone(),
        prepared: workspace
            .as_ref()
            .map(|prepared| Box::new(prepared.clone())),
    })?;
    let outcome = adapter::execute(
        options,
        assignment,
        (
            checkpoint,
            workspace
                .as_ref()
                .map(|prepared| prepared.checkout.path.as_path()),
        ),
        (host.clone(), inputs.clone(), workstream_client.clone()),
        token,
        valid_until,
        shutdown,
    )
    .await
    .with_context(|| {
        format!(
            "Task {} Attempt {} needs recovery",
            attempt.task_id, attempt.attempt_id
        )
    })?;
    match workspace {
        Some(workspace) => {
            let checkpoint = outcome
                .checkpoint
                .map(|checkpoint| journal.stage_checkpoint(checkpoint))
                .transpose()?;
            journal.save(&Entry::Finalizing {
                attempt,
                result: outcome.result,
                succeeded: outcome.succeeded,
                objective_signal: outcome.objective_signal,
                waiting_approval_ids: outcome.waiting_approval_ids,
                checkpoint,
                workspace: Box::new(workspace),
            })
        }
        None => save_finish(journal, attempt, outcome),
    }
}

fn ensure_attempt(task: &Task, attempt: &Attempt) -> Result<()> {
    ensure!(
        task.task_id == attempt.task_id
            && task.attempt_id.as_deref() == Some(attempt.attempt_id.as_str()),
        "Control Plane returned a different Task Attempt"
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
    })
}

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
    let renew = |host: &mut RegisteredHost| {
        let mut client = host.clone();
        let inspection = attempt.inspect();
        async move {
            let sent = Instant::now();
            let response = client
                .renew_attempt(
                    request(inspection, token)
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
    };
    let mut valid_until = renew(host).await?;
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
                match time::timeout_at(valid_until, renew(host)).await {
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
    )
}

async fn wait_for_work(shutdown: &CancellationToken) {
    tokio::select! {
        _ = time::sleep(Duration::from_millis(250)) => {}
        _ = shutdown.cancelled() => {}
    }
}
