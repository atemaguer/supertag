mod adapter;
mod guardian;
mod journal;

pub use guardian::guard_adapter;

use std::{ffi::OsString, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use journal::{Entry, Journal};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        Assignment, ClaimTaskRequest, FinishTaskRequest, InspectAttemptRequest, StartTaskRequest,
        TaskState, worker_host_client::WorkerHostClient,
    },
};
use tokio::time;
use tokio_util::sync::CancellationToken;
use tonic::{
    Request,
    transport::{Channel, Endpoint},
};
use uuid::Uuid;

pub struct HostOptions {
    pub gateway: Endpoint,
    pub token: String,
    pub state_directory: PathBuf,
    pub adapter_guardian: PathBuf,
    pub adapter: PathBuf,
    pub adapter_args: Vec<OsString>,
    pub attempt_timeout: Duration,
    pub once: bool,
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
                    if shutdown.is_cancelled() {
                        break;
                    }
                    run_assignment(&options, &journal, &mut host, assignment, &shutdown).await?;
                } else {
                    journal.clear()?;
                    if options.once {
                        return Ok(());
                    }
                    wait_for_work(&shutdown).await;
                }
            }
            Entry::Executing {
                task_id,
                attempt_id,
            } => {
                bail!(
                    "Task {task_id} Attempt {attempt_id} needs recovery before this host can claim work"
                );
            }
            Entry::Finish {
                task_id,
                attempt_id,
                lease_token,
                result,
                succeeded,
            } => {
                let outcome = host
                    .finish_task(request(
                        FinishTaskRequest {
                            task_id,
                            attempt_id,
                            lease_token,
                            result,
                            succeeded,
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

async fn run_assignment(
    options: &HostOptions,
    journal: &Journal,
    host: &mut WorkerHostClient<Channel>,
    assignment: Assignment,
    shutdown: &CancellationToken,
) -> Result<()> {
    let task_id = assignment
        .task
        .as_ref()
        .context("assignment has no Task")?
        .task_id
        .clone();
    let attempt_id = assignment.attempt_id.clone();
    let lease_token = assignment.lease_token.clone();
    journal.save(&Entry::Executing {
        task_id: task_id.clone(),
        attempt_id: attempt_id.clone(),
    })?;
    let start = host
        .start_task(request(
            StartTaskRequest {
                task_id: task_id.clone(),
                attempt_id: attempt_id.clone(),
                lease_token: lease_token.clone(),
            },
            &options.token,
        )?)
        .await;
    let task = match start {
        Ok(response) => response.into_inner(),
        Err(error) if error.code() == tonic::Code::FailedPrecondition => {
            let task = host
                .inspect_attempt(request(
                    InspectAttemptRequest {
                        task_id: task_id.clone(),
                        attempt_id: attempt_id.clone(),
                        lease_token: lease_token.clone(),
                    },
                    &options.token,
                )?)
                .await?
                .into_inner();
            if task.state() != TaskState::Cancelled {
                return Err(error.into());
            }
            task
        }
        Err(error) => return Err(error.into()),
    };
    if task.state() == TaskState::Cancelled {
        return journal.clear();
    }
    ensure!(
        task.state() == TaskState::Running,
        "Control Plane did not authorize the Task Attempt to start"
    );
    let assignment = Assignment {
        task: Some(task),
        ..assignment
    };
    let outcome = adapter::execute(options, assignment, host.clone(), shutdown)
        .await
        .with_context(|| format!("Task {task_id} Attempt {attempt_id} needs recovery"))?;
    journal.save(&Entry::Finish {
        task_id,
        attempt_id,
        lease_token,
        result: outcome.result,
        succeeded: outcome.succeeded,
    })
}

fn request<T>(message: T, token: &str) -> Result<Request<T>> {
    let mut request = authenticated_request(message, token, None)?;
    request.set_timeout(Duration::from_secs(5));
    Ok(request)
}

fn retryable(error: &tonic::Status) -> bool {
    matches!(
        error.code(),
        tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
    )
}

async fn wait_for_work(shutdown: &CancellationToken) {
    tokio::select! {
        _ = time::sleep(Duration::from_millis(250)) => {}
        _ = shutdown.cancelled() => {}
    }
}
