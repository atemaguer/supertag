//! The journal-facing end of an Attempt: recording its outcome for Finish, stopping its
//! providers, and writing its Session branch.

use anyhow::{Context, Result};
use supertag_protocol::v2::{HarnessCompleteRequest, HostRecord};
use tokio_util::sync::CancellationToken;

use crate::{
    RegisteredHost, WorkerOptions, failures, request,
    worker::{remote, shared_execution},
    worklet::{
        journal::{Attempt, Entry, Journal},
        workspaces,
    },
};

/// Records a Worker Host's own verdict on an Attempt. A failure is also named in the Worker
/// Host log, so the operator reading it learns why without the Control Plane.
pub(crate) fn save_finish(
    journal: &Journal,
    attempt: Attempt,
    outcome: HarnessCompleteRequest,
) -> Result<()> {
    if !outcome.succeeded {
        supertag_protocol::terminal_text::warn(&format!(
            "Task {} Attempt {} failed: {}",
            attempt.task_id, attempt.attempt_id, outcome.result
        ));
    }
    record_finish(journal, attempt, outcome)
}

/// Records the adapter's outcome, which the adapter run already explained in the log.
pub(crate) fn record_finish(
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

pub(crate) async fn ensure_providers_stopped(
    options: &WorkerOptions,
    journal: &Journal,
    attempt: &Attempt,
    registration: &HostRecord,
) -> Result<()> {
    remote::ensure_stopped(options, journal, attempt, registration).await?;
    shared_execution::ensure_released(options, journal, attempt, registration).await
}

/// Writes `pending`'s Session branch into its local Workspace's repository, noting a failure.
pub(crate) async fn write_session_branch(
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
