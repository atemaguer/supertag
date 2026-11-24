//! The Worklet's part of starting a claimed Attempt: start it under its lease, resolve the
//! branch its Workspace follows, check that this host can enforce what the Task was accepted
//! with, read the Session checkpoint this host holds, and prepare its checkout. What it hands a
//! Worker in `Assign` comes from here.

use std::time::Duration;

use anyhow::{Context, Result, ensure};
use supertag_protocol::v2::{SessionCheckpoint, Task, TaskState};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use tonic::{Code, Status};

use crate::{
    WorkerOptions, ensure_attempt, failures, lost_ownership, retryable, wait_for_work,
    worker::adapter,
    worklet::{
        authority::{AUTHORITY_EXPIRED, Authority},
        checkpoints,
        journal::Attempt,
        workspaces,
    },
};

/// What a failed Task's result begins with when its checkout could not be prepared.
const PREPARE_FAILED: &str = "Task workspace could not be prepared safely";

/// A started Attempt, ready for a Worker.
pub(crate) struct Launched {
    /// Carries the Attempt credential its start returned, for the Worker only.
    pub(crate) attempt: Attempt,
    pub(crate) task: Task,
    pub(crate) workspace: Option<workspaces::PreparedWorkspace>,
    pub(crate) checkpoint: Option<SessionCheckpoint>,
    pub(crate) valid_until: Instant,
}

/// Starts the journaled Attempt. `None` when the journal already holds what happened instead
/// (a verdict, a release) or the start should be tried again later; `ready` is called once the
/// host has answered for it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn launch(
    options: &WorkerOptions,
    attempt: Attempt,
    workspaces: &workspaces::Workspaces,
    transfers: &checkpoints::Transfers,
    shutdown: &CancellationToken,
    mut authority: Authority<'_>,
    ready: impl FnOnce(),
) -> Result<Option<Launched>> {
    let mut attempt = attempt;
    // Starting is durable before requesting authority and never records a launch.
    // A lost start response can therefore be retried using this exact Attempt.
    let can_launch = attempt.can_launch(options)?;
    let start = if can_launch {
        authority.start(&attempt).await?
    } else {
        authority
            .inspect(&attempt)
            .await?
            .map(|task| supertag_protocol::v2::StartTaskResponse {
                task: Some(task),
                attempt_credential: String::new(),
            })
    };
    let task = match start {
        Ok(started) => {
            if can_launch {
                supertag_protocol::crash_point("worker-host.start", "answered");
            }
            // The Attempt credential is the only one the Worker's data calls carry. A replayed
            // start returns a new one and ends the last.
            attempt.attempt_credential = started.attempt_credential;
            started
                .task
                .context("Control Plane started the Attempt without its Task")?
        }
        Err(error) if retryable(&error) => {
            wait_for_work(shutdown).await;
            return Ok(None);
        }
        Err(error) if lost_ownership(&error) => {
            match authority.inspect(&attempt).await? {
                Ok(task) => task,
                Err(error) if retryable(&error) => {
                    wait_for_work(shutdown).await;
                    return Ok(None);
                }
                // No adapter was launched for Starting. The Control Plane can
                // safely retire a reservation that expired before start.
                Err(error) if lost_ownership(&error) => {
                    return authority.discard_prelaunch(&attempt).map(|()| None);
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
            // Starting never launched an adapter.
            return authority.release_unstarted().map(|()| None);
        }
        return authority
            .finish(
                attempt,
                adapter::failed("Worker Host execution profile changed before launch"),
            )
            .map(|()| None);
    }
    if task.state() == TaskState::Claimed {
        // A pause can block Start after Claim. No adapter has launched, so
        // retain the intent while the Control Plane retires the reservation.
        ready();
        wait_for_work(shutdown).await;
        return Ok(None);
    }
    if matches!(task.state(), TaskState::Cancelled | TaskState::Uncertain) {
        ready();
        return authority
            .finish(attempt, adapter::failed("Task Attempt ended before launch"))
            .map(|()| None);
    }
    ensure!(
        task.state() == TaskState::Running,
        "Control Plane did not authorize the Task Attempt to start"
    );
    if attempt.attempt_credential.is_empty() {
        // Started, but its start answer was lost to a refusal: nothing launched, and no data
        // call can be made for it.
        return authority
            .finish(
                attempt,
                adapter::failed("Execution authority ended before launch"),
            )
            .map(|()| None);
    }

    let sent = Instant::now();
    let renewed = authority.renew(&attempt).await?;
    let granted = match renewed {
        Ok(granted) => granted,
        Err(error) if retryable(&error) => {
            wait_for_work(shutdown).await;
            return Ok(None);
        }
        Err(error) if lost_ownership(&error) => {
            return authority.discard_prelaunch(&attempt).map(|()| None);
        }
        Err(error) => return Err(error.into()),
    };
    ready();
    let mut task = granted.task.context("execution authority has no Task")?;
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
            workspaces::BranchResolution::Interrupted => return Ok(None),
            workspaces::BranchResolution::Failed(message) => {
                return authority
                    .finish(attempt, adapter::failed(&message))
                    .map(|()| None);
            }
        };
        match authority.resolve_workspace_ref(&attempt, commit).await? {
            Ok(resolved) => {
                task = resolved;
                ensure_attempt(&task, &attempt)?;
            }
            Err(error) if retryable(&error) => {
                wait_for_work(shutdown).await;
                return Ok(None);
            }
            Err(error) if lost_ownership(&error) => {
                return authority.discard_prelaunch(&attempt).map(|()| None);
            }
            Err(error) => return Err(error.into()),
        }
    }
    let valid_until = sent
        .checked_add(Duration::from_millis(granted.valid_for_ms))
        .context("invalid execution authority duration")?;
    if task.state() != TaskState::Running || valid_until <= Instant::now() {
        return authority
            .finish(
                attempt,
                adapter::failed("Execution authority expired before launch"),
            )
            .map(|()| None);
    }
    if !supertag_protocol::mcp::supports(&task, options.harness, &options.execution_profile) {
        return authority
            .finish(
                attempt,
                adapter::failed("Worker Host cannot enforce accepted MCP grants"),
            )
            .map(|()| None);
    }
    if !supertag_protocol::shared_execution::supports(
        &task,
        options.harness,
        options.execution_profile.shared_execution.as_ref(),
    ) {
        return authority
            .finish(
                attempt,
                adapter::failed("Worker Host cannot enforce accepted shared execution placement"),
            )
            .map(|()| None);
    }
    if !supertag_protocol::network_scope::supports(
        &task,
        options.harness,
        &options.execution_profile,
    ) {
        return authority
            .finish(
                attempt,
                adapter::failed("Worker Host cannot enforce the Task's network scope"),
            )
            .map(|()| None);
    }
    if !supertag_protocol::output_policy::supports(
        &task,
        options.harness,
        &options.execution_profile,
    ) {
        return authority
            .finish(
                attempt,
                adapter::failed("Worker Host cannot enforce accepted Task output requirements"),
            )
            .map(|()| None);
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
        return authority
            .finish(
                attempt,
                adapter::failed("Worker Host cannot materialize accepted Task artifact inputs"),
            )
            .map(|()| None);
    }
    let checkpoint = match time::timeout_at(
        valid_until,
        transfers.download(&attempt, (&task.tag_id, &task.session_id)),
    )
    .await
    {
        Ok(Ok(checkpoint)) => {
            checkpoint.filter(|checkpoint| checkpoints::resumable(options.harness, checkpoint))
        }
        Ok(Err(error)) if retryable(&error) || error.code() == Code::ResourceExhausted => {
            wait_for_work(shutdown).await;
            return Ok(None);
        }
        Ok(Err(error)) if lost_ownership(&error) || error.code() == Code::DataLoss => {
            return authority
                .finish(
                    attempt,
                    adapter::failed("Session checkpoint could not be restored"),
                )
                .map(|()| None);
        }
        Ok(Err(error)) => return Err(error.into()),
        Err(_) => {
            return authority
                .finish(
                    attempt,
                    adapter::failed("Execution authority expired during checkpoint transfer"),
                )
                .map(|()| None);
        }
    };
    let operation_cancel = shutdown.child_token();
    let prepared = authority
        .keep(&attempt, &operation_cancel, async {
            workspaces
                .prepare(&task, &attempt, transfers, &operation_cancel)
                .await
                .map_err(|error| {
                    // The whole cause goes to this host's log and the Attempt's failure detail;
                    // the Task's result says as much of it as is safe to show.
                    error.downcast::<Status>().unwrap_or_else(|error| {
                        failures::note(PREPARE_FAILED, &format!("{error:#}"));
                        Status::invalid_argument(failures::shown(PREPARE_FAILED, &error))
                    })
                })
        })
        .await;
    let (workspace, valid_until) = match prepared {
        Ok(prepared) => {
            if task.waiting_for_holder.is_some() {
                authority.report_waiting_for_holder(&attempt, false).await;
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
                authority.report_waiting_for_holder(&attempt, true).await;
            }
            wait_for_work(shutdown).await;
            return Ok(None);
        }
        Err(error) => {
            // A failed setup names itself and keeps its untrusted output, as TypeScript's
            // `workspace-setup` failure does.
            let message = if error.message().starts_with("Workspace setup")
                || error.message().starts_with(PREPARE_FAILED)
            {
                error.message().to_owned()
            } else if error.message() == AUTHORITY_EXPIRED {
                "Execution authority expired while the Task workspace was prepared".to_owned()
            } else {
                // A call the preparation made was refused, by the Control Plane or this host:
                // the status is its own account of why, and was logged nowhere until now.
                let cause = format!("{:?}: {}", error.code(), error.message());
                failures::note(PREPARE_FAILED, &cause);
                failures::shown(PREPARE_FAILED, &anyhow::anyhow!(cause))
            };
            return authority
                .finish(attempt, adapter::failed(&message))
                .map(|()| None);
        }
    };
    if task.state() != TaskState::Running || valid_until <= Instant::now() {
        return authority
            .finish(
                attempt,
                adapter::failed("Execution authority expired before launch"),
            )
            .map(|()| None);
    }
    Ok(Some(Launched {
        attempt,
        task,
        workspace,
        checkpoint,
        valid_until,
    }))
}
