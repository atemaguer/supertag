mod adapter;
mod guardian;
mod journal;

pub use guardian::{CODEX_ATTEMPT_DIRECTORY, guard_adapter};

use std::{ffi::OsString, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use journal::{Attempt, Entry, Journal};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        Assignment, ClaimTaskRequest, FinishTaskRequest, HarnessCompleteRequest,
        InspectAttemptRequest, StartTaskRequest, Task, TaskState,
        worker_host_client::WorkerHostClient,
    },
};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use tonic::{
    Code, Request, Status,
    transport::{Channel, Endpoint},
};
use uuid::Uuid;

/// Local sign-in and model provider settings accepted by the built-in Codex adapter.
pub const CODEX_ENVIRONMENT: &[&str] = &["HOME", "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"];

pub struct HostOptions {
    pub gateway: Endpoint,
    pub token: String,
    pub state_directory: PathBuf,
    pub adapter_guardian: PathBuf,
    pub adapter: PathBuf,
    pub adapter_args: Vec<OsString>,
    pub forward_codex_credentials: bool,
    pub attempt_timeout: Duration,
    pub wait_for_recovery: bool,
    pub once: bool,
}

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
    ensure!(!options.token.is_empty(), "Worker Host credential required");
    ensure!(
        !options.attempt_timeout.is_zero(),
        "attempt timeout must be positive"
    );
    let journal = Journal::open(&options.state_directory)?;
    let mut host = WorkerHostClient::new(options.gateway.clone().connect_lazy())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
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
        match entry {
            Entry::Claim { operation_id } => {
                let response = host
                    .claim_task(request(ClaimTaskRequest { operation_id }, &options.token)?)
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
                run_assignment(&options, &journal, &mut host, attempt, &shutdown, || {
                    if let Some(ready) = ready.take() {
                        ready();
                    }
                })
                .await?;
            }
            Entry::Executing { attempt } => {
                match resolved(&mut host, &attempt, &options.token).await {
                    Ok(true) => journal.clear()?,
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
            Entry::Finish {
                attempt,
                result,
                succeeded,
                objective_signal,
            } => {
                let outcome = host
                    .finish_task(request(
                        FinishTaskRequest {
                            task_id: attempt.task_id.clone(),
                            attempt_id: attempt.attempt_id.clone(),
                            lease_token: attempt.lease_token.clone(),
                            result,
                            succeeded,
                            objective_signal,
                        },
                        &options.token,
                    )?)
                    .await;
                match outcome {
                    Ok(_) => {}
                    Err(error) if retryable(&error) => {
                        wait_for_work(&shutdown).await;
                        continue;
                    }
                    Err(error)
                        if error.code() == Code::InvalidArgument && objective_signal != 0 =>
                    {
                        // An invalid owner signal is rejected before the Finish transaction
                        // commits. Settle the cleaned-up Attempt as a controlled failure.
                        save_finish(
                            &journal,
                            attempt,
                            adapter::failed("Harness proposed an invalid Objective update"),
                        )?;
                        continue;
                    }
                    Err(error) if lost_ownership(&error) || error.code() == Code::AlreadyExists => {
                        match resolved(&mut host, &attempt, &options.token).await {
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
                journal.clear()?;
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
}

async fn resolved(
    host: &mut WorkerHostClient<Channel>,
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
    host: &mut WorkerHostClient<Channel>,
    attempt: Attempt,
    shutdown: &CancellationToken,
    ready: impl FnOnce(),
) -> Result<()> {
    // Starting is durable before requesting authority and never records a launch.
    // A lost start response can therefore be retried using this exact Attempt.
    let start = host
        .start_task(request(
            StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
            &options.token,
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
                .inspect_attempt(request(attempt.inspect(), &options.token)?)
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
    let renewed = host
        .renew_attempt(request(attempt.inspect(), &options.token)?)
        .await;
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
    let assignment = Assignment {
        task: Some(task),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
    };
    journal.save(&Entry::Executing {
        attempt: attempt.clone(),
    })?;
    let outcome = adapter::execute(options, assignment, host.clone(), valid_until, shutdown)
        .await
        .with_context(|| {
            format!(
                "Task {} Attempt {} needs recovery",
                attempt.task_id, attempt.attempt_id
            )
        })?;
    save_finish(journal, attempt, outcome)
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
    journal.save(&Entry::Finish {
        attempt,
        result: outcome.result,
        succeeded: outcome.succeeded,
        objective_signal: outcome.objective_signal,
    })
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
