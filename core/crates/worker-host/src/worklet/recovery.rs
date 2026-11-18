//! Recovering an interrupted Attempt, and ending a settled one's local state.

use std::time::Duration;

use anyhow::{Result, ensure};
use supertag_protocol::{authenticated_request, v2::ReclaimAttemptRequest};
use tonic::Status;

use crate::{
    RegisteredHost, failures, request, retryable,
    worker::context,
    worklet::{
        journal::{Attempt, Journal},
        workspaces,
    },
    workspace_mounts,
};

/// Names the uncertain Attempt that keeps this host from claiming work, and the command that
/// resolves it.
pub(crate) fn recovery_notice(attempt: &Attempt) -> String {
    format!(
        "Task {task} Attempt {id} needs recovery before this host can claim work. Once you confirm its execution stopped: supertag task resolve-attempt {task} {id} --decision retry --confirmed-stopped --evidence TEXT (or --decision failed)",
        task = attempt.task_id,
        id = attempt.attempt_id,
    )
}

/// Ends a settled Attempt's local state. Its checkout is only moved aside here; deleting it,
/// which took seconds for a large repository, overlaps the next claim: see `purge_discarded`.
/// Returns the workspace state directory to purge.
pub(crate) fn cleanup_terminal(
    journal: &Journal,
    workspaces: &workspaces::Workspaces,
    state_directory: &std::path::Path,
    attempt: &Attempt,
    prepared: Option<&workspaces::PreparedWorkspace>,
) -> Result<Option<std::path::PathBuf>> {
    workspace_mounts::cleanup(state_directory, &attempt.attempt_id)?;
    let discarded = prepared
        .map(|prepared| workspaces.discard(prepared))
        .transpose()?;
    context::discard_attempt(state_directory, &attempt.attempt_id)?;
    journal.clear()?;
    Ok(discarded)
}

/// Deletes a discarded checkout in the background, so the next claim does not wait for it. A
/// `--once` host has no next claim and deletes it before it exits.
pub(crate) fn purge_discarded(state: Option<std::path::PathBuf>, once: bool) {
    let Some(state) = state else {
        return;
    };
    let purge = move || {
        if let Err(error) = supertag_workspaces::purge_discarded(&state) {
            failures::note_unrecorded("Discarded checkouts could not be deleted", &error);
        }
    };
    if once {
        purge();
    } else {
        std::thread::spawn(purge);
    }
}

pub(crate) async fn resolved(
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

/// Reclaims an interrupted Attempt when its process record proves every process it started is
/// gone, as TypeScript's automatic reclaim does. Returns whether the Control Plane recorded it;
/// without proof, or when the Control Plane refuses, the Attempt waits for an operator.
pub(crate) async fn reclaim(
    host: &mut RegisteredHost,
    journal: &Journal,
    attempt: &Attempt,
    token: &str,
) -> Result<bool> {
    let Some(evidence) = journal.processes(attempt).stopped()? else {
        return Ok(false);
    };
    let mut request = request(
        ReclaimAttemptRequest {
            attempt: Some(attempt.inspect()),
            evidence,
        },
        token,
    )?;
    request.set_timeout(Duration::from_secs(5));
    match host.reclaim_attempt(request).await {
        Ok(response) => {
            let resolution = response.into_inner();
            ensure!(
                resolution.task_id == attempt.task_id
                    && resolution.attempt_id == attempt.attempt_id,
                "recovery receipt has mismatched identity"
            );
            Ok(true)
        }
        Err(error) if retryable(&error) => Ok(false),
        Err(error)
            if matches!(
                error.code(),
                tonic::Code::FailedPrecondition | tonic::Code::AlreadyExists | tonic::Code::Aborted
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}
