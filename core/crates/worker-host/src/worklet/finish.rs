//! The journal-facing end of an Attempt: recording its outcome for Finish, stopping its
//! providers, and writing its Session branch.

use anyhow::{Context, Result};
use supertag_protocol::v2::{
    AttemptMilestone, HarnessCompleteRequest, HostRecord, ReportAttemptMilestoneRequest,
    StartTaskRequest,
};
use tokio_util::sync::CancellationToken;
use tonic::Status;

use crate::{
    RegisteredHost, WorkerOptions, ensure_attempt, failures, request, retryable,
    worker::{remote, shared_execution},
    worklet::{
        authority::with_cleanup_authority,
        journal::{Attempt, Entry, Journal},
        workspaces,
    },
};

/// Reports the turn's reply from `entry` until the Control Plane acknowledges it, and records
/// that it did. The Worker reports it once, without waiting, as the harness finishes, and its
/// outcome says whether that report was acknowledged; a report it lost, or never sent because it
/// died, would leave an Attempt that cannot finish, such as one fenced until its cleanup is
/// confirmed, without the reply. The Control Plane shows a
/// reply once per Attempt, so one the Worker's report already showed changes nothing. Returns
/// the entry, marked when the report was acknowledged; a report that fails goes again the next
/// time the slot reads the entry, and the Attempt goes on meanwhile.
pub(crate) async fn deliver_reply(
    host: &mut RegisteredHost,
    journal: &Journal,
    mut entry: Entry,
    token: &str,
    shutdown: &CancellationToken,
) -> Result<Entry> {
    let Some((attempt, reply, quiet, objective_signal)) = entry.unreported_reply() else {
        return Ok(entry);
    };
    let attempt = attempt.clone();
    #[cfg(feature = "test-fixtures")]
    note_resend(&attempt);
    let milestone = ReportAttemptMilestoneRequest {
        milestone: AttemptMilestone::HarnessFinished as i32,
        reply: Some(reply.to_owned()),
        quiet,
        objective_signal,
    };
    let mut reporter = host.clone();
    let mut reported = Ok(false);
    // The lease is renewed meanwhile: no Worker holds it now.
    with_cleanup_authority(host, &attempt, token, shutdown, async {
        reported = report_reply(&mut reporter, &attempt, token, milestone).await;
        Ok(())
    })
    .await?;
    match reported {
        Ok(false) => return Ok(entry),
        Ok(true) => {}
        // Refused for good: the Attempt's Finish still carries the reply.
        Err(error) => {
            failures::note_unrecorded("The harness's reply could not be reported", &error)
        }
    }
    entry.reply_reported();
    journal.save(&entry)?;
    Ok(entry)
}

/// Reports `milestone` for `attempt` with an Attempt credential minted for it, as the Worker
/// would: a repeated start mints one and ends the last, which no running Worker holds now.
/// Returns whether the report is settled: acknowledged, or refused because the Attempt no
/// longer runs under this lease, which has no running Task left to show the reply on. A report
/// that may succeed later returns `false`; one refused otherwise, an error.
async fn report_reply(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    milestone: ReportAttemptMilestoneRequest,
) -> Result<bool> {
    let started = host
        .start_task(request(
            StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
            token,
        )?)
        .await;
    let started = match started {
        Ok(started) => started.into_inner(),
        Err(error) => return settled(error),
    };
    ensure_attempt(
        started
            .task
            .as_ref()
            .context("Control Plane started the Attempt without its Task")?,
        attempt,
    )?;
    anyhow::ensure!(
        !started.attempt_credential.is_empty(),
        "Control Plane started the Attempt without its credential"
    );
    match host
        .report_attempt_milestone(request(milestone, &started.attempt_credential)?)
        .await
    {
        Ok(_) => Ok(true),
        Err(error) => settled(error),
    }
}

/// Test builds name a file in `SUPERTAG_TEST_REPLY_RESENDS` that gets a line, the Attempt's id,
/// for each reply the Worklet reports again.
#[cfg(feature = "test-fixtures")]
fn note_resend(attempt: &Attempt) {
    use std::io::Write as _;
    if let Some(path) = std::env::var_os("SUPERTAG_TEST_REPLY_RESENDS")
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
    {
        let _ = writeln!(file, "{}", attempt.attempt_id);
    }
}

fn settled(error: Status) -> Result<bool> {
    if retryable(&error) {
        Ok(false)
    } else if crate::lost_ownership(&error) || error.code() == tonic::Code::Unauthenticated {
        Ok(true)
    } else {
        Err(error.into())
    }
}

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
        reply_reported: false,
    })
}

pub(crate) async fn ensure_providers_stopped(
    options: &WorkerOptions,
    journal: &Journal,
    attempt: &Attempt,
    registration: &HostRecord,
) -> Result<()> {
    remote::ensure_stopped(options, journal.for_attempt(), attempt, registration).await?;
    shared_execution::ensure_released(options, journal.for_attempt(), attempt, registration).await
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
