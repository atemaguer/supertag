//! The Attempt milestones a Worker reports, best effort, for `supertag metrics`.

use std::{sync::Mutex, time::Duration};

use tokio::task::JoinHandle;

use crate::{request, worklet::authority::AttemptClient};

/// The reports still in flight, each answering whether the Control Plane acknowledged it. The
/// Worker waits for them before it exits.
static IN_FLIGHT: Mutex<Vec<JoinHandle<bool>>> = Mutex::new(Vec::new());

/// The report that carries the harness's reply. The Worker's outcome says whether it was
/// acknowledged (`reply_acknowledged`); when it was not, the Worklet reports the reply again from
/// its journal (`worklet::finish::deliver_reply`), so a report that is lost only delays it.
static REPLY: Mutex<Option<JoinHandle<bool>>> = Mutex::new(None);

/// How long a Worker that is about to exit waits for its reports.
const FLUSH_WITHIN: Duration = Duration::from_secs(10);

/// Tells the Control Plane, in the background and best-effort, that the Attempt reached
/// `milestone`, for `supertag metrics`. The run never waits on it.
pub(crate) fn report_milestone(
    host: &AttemptClient,
    token: &str,
    milestone: supertag_protocol::v2::AttemptMilestone,
) {
    send_milestone(
        host,
        token,
        supertag_protocol::v2::ReportAttemptMilestoneRequest {
            milestone: milestone as i32,
            ..Default::default()
        },
    );
}

/// Set in a test build's environment, the Worker never sends its HarnessFinished report.
#[cfg(feature = "test-fixtures")]
const DROP_HARNESS_FINISHED_ENV: &str = "SUPERTAG_TEST_DROP_HARNESS_FINISHED";

/// The harness finished the turn, with its reply, quiet flag and Objective signal when it
/// succeeded and waits for no approval.
pub(crate) fn report_harness_finished(
    host: &AttemptClient,
    token: &str,
    reply: Option<(String, bool, i32)>,
) {
    // Test builds can lose the report, as a slow Control Plane or a Worker that died would: the
    // Worklet reports the reply again from its journal.
    #[cfg(feature = "test-fixtures")]
    if std::env::var_os(DROP_HARNESS_FINISHED_ENV).is_some() {
        return;
    }
    let (reply, quiet, objective_signal) = match reply {
        Some((text, quiet, signal)) => (Some(text), quiet, signal),
        None => (None, false, 0),
    };
    let replies = reply.is_some();
    let report = spawn_report(
        host,
        token,
        supertag_protocol::v2::ReportAttemptMilestoneRequest {
            milestone: supertag_protocol::v2::AttemptMilestone::HarnessFinished as i32,
            reply,
            quiet,
            objective_signal,
        },
    );
    match report {
        Some(report) if replies => {
            *REPLY.lock().unwrap_or_else(|error| error.into_inner()) = Some(report);
        }
        Some(report) => in_flight(report),
        None => {}
    }
}

pub(crate) fn send_milestone(
    host: &AttemptClient,
    token: &str,
    input: supertag_protocol::v2::ReportAttemptMilestoneRequest,
) {
    if let Some(report) = spawn_report(host, token, input) {
        in_flight(report);
    }
}

/// Sends `input` in the background; the task answers whether the Control Plane acknowledged it.
fn spawn_report(
    host: &AttemptClient,
    token: &str,
    input: supertag_protocol::v2::ReportAttemptMilestoneRequest,
) -> Option<JoinHandle<bool>> {
    let report = request(input, token).ok()?;
    let mut host = host.clone();
    Some(tokio::spawn(async move {
        match host.report_attempt_milestone(report).await {
            Ok(_) => true,
            Err(error) => {
                tracing::debug!("could not report an Attempt milestone: {error}");
                false
            }
        }
    }))
}

fn in_flight(report: JoinHandle<bool>) {
    let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|error| error.into_inner());
    in_flight.retain(|report| !report.is_finished());
    in_flight.push(report);
}

/// Whether the Control Plane acknowledged this Worker's report of the harness's reply, waiting up
/// to [`FLUSH_WITHIN`] for one still in flight. `false` when the Worker sent none: a turn with no
/// reply to show has nothing for the Worklet to report either. A report still in flight after the
/// wait goes on, and the Worker waits for it again as it exits.
pub(crate) async fn reply_acknowledged() -> bool {
    let report = REPLY
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    let Some(mut report) = report else {
        return false;
    };
    match tokio::time::timeout(FLUSH_WITHIN, &mut report).await {
        Ok(acknowledged) => acknowledged.unwrap_or(false),
        Err(_) => {
            in_flight(report);
            false
        }
    }
}

pub(crate) const WORKSPACE_READY: supertag_protocol::v2::AttemptMilestone =
    supertag_protocol::v2::AttemptMilestone::WorkspaceReady;

/// Waits, up to [`FLUSH_WITHIN`], for the reports still in flight. A report that takes longer
/// is dropped, as a best-effort report may be.
pub(crate) async fn flush() {
    let mut reports =
        std::mem::take(&mut *IN_FLIGHT.lock().unwrap_or_else(|error| error.into_inner()));
    reports.extend(
        REPLY
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take(),
    );
    let all = async {
        for report in reports {
            let _ = report.await;
        }
    };
    if tokio::time::timeout(FLUSH_WITHIN, all).await.is_err() {
        tracing::debug!("an Attempt milestone report was still in flight as the Worker exited");
    }
}
