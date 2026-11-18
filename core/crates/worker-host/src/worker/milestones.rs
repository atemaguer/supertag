//! The Attempt milestones a Worker reports, best effort, for `supertag metrics`.

use crate::{request, worklet::authority::AttemptClient};

/// Tells the Control Plane, in the background and best-effort, that the Attempt reached
/// `milestone`, for `supertag metrics`. The run never waits on it.
pub(crate) fn report_milestone(
    host: &AttemptClient,
    attempt: &supertag_protocol::v2::InspectAttemptRequest,
    token: &str,
    milestone: supertag_protocol::v2::AttemptMilestone,
) {
    send_milestone(
        host,
        token,
        supertag_protocol::v2::ReportAttemptMilestoneRequest {
            attempt: Some(attempt.clone()),
            milestone: milestone as i32,
            ..Default::default()
        },
    );
}

/// The harness finished the turn, with its reply, quiet flag and Objective signal when it
/// succeeded and waits for no approval.
pub(crate) fn report_harness_finished(
    host: &AttemptClient,
    attempt: &supertag_protocol::v2::InspectAttemptRequest,
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
            attempt: Some(attempt.clone()),
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
    tokio::spawn(async move {
        if let Err(error) = host.report_attempt_milestone(report).await {
            tracing::debug!("could not report an Attempt milestone: {error}");
        }
    });
}

pub(crate) const WORKSPACE_READY: supertag_protocol::v2::AttemptMilestone =
    supertag_protocol::v2::AttemptMilestone::WorkspaceReady;
