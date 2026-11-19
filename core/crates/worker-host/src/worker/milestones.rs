//! The Attempt milestones a Worker reports, best effort, for `supertag metrics`.

use std::{sync::Mutex, time::Duration};

use tokio::task::JoinHandle;

use crate::{request, worklet::authority::AttemptClient};

/// The reports still in flight. The Worker waits for them before it exits, since the harness's
/// reply travels in one: a Worker that exits right after its outcome would otherwise drop it.
static IN_FLIGHT: Mutex<Vec<JoinHandle<()>>> = Mutex::new(Vec::new());

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

/// The harness finished the turn, with its reply, quiet flag and Objective signal when it
/// succeeded and waits for no approval.
pub(crate) fn report_harness_finished(
    host: &AttemptClient,
    token: &str,
    reply: Option<(String, bool, i32)>,
) {
    let (reply, quiet, objective_signal) = match reply {
        Some((text, quiet, signal)) => (Some(text), quiet, signal),
        None => (None, false, 0),
    };
    send_milestone(
        host,
        token,
        supertag_protocol::v2::ReportAttemptMilestoneRequest {
            milestone: supertag_protocol::v2::AttemptMilestone::HarnessFinished as i32,
            reply,
            quiet,
            objective_signal,
        },
    );
}

pub(crate) fn send_milestone(
    host: &AttemptClient,
    token: &str,
    input: supertag_protocol::v2::ReportAttemptMilestoneRequest,
) {
    let Ok(report) = request(input, token) else {
        return;
    };
    let mut host = host.clone();
    let report = tokio::spawn(async move {
        if let Err(error) = host.report_attempt_milestone(report).await {
            tracing::debug!("could not report an Attempt milestone: {error}");
        }
    });
    let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|error| error.into_inner());
    in_flight.retain(|report| !report.is_finished());
    in_flight.push(report);
}

pub(crate) const WORKSPACE_READY: supertag_protocol::v2::AttemptMilestone =
    supertag_protocol::v2::AttemptMilestone::WorkspaceReady;

/// Waits, up to [`FLUSH_WITHIN`], for the reports still in flight. A report that takes longer
/// is dropped, as a best-effort report may be.
pub(crate) async fn flush() {
    let reports = std::mem::take(&mut *IN_FLIGHT.lock().unwrap_or_else(|error| error.into_inner()));
    let all = async {
        for report in reports {
            let _ = report.await;
        }
    };
    if tokio::time::timeout(FLUSH_WITHIN, all).await.is_err() {
        tracing::debug!("an Attempt milestone report was still in flight as the Worker exited");
    }
}
