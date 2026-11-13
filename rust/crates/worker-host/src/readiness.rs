//! Presence runs independently of a Task's execution lease and native process.

use std::{sync::Arc, time::Duration};

use anyhow::Result;
use supertag_protocol::v2::{
    HarnessExecutionProfile, HostReadiness, HostReadinessReason, ReportHostRequest,
};
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::{RegisteredHost, environment::DiskSpaceSource, journal::Journal, request, retryable};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum State {
    Pending,
    Ready,
    Busy,
    Recovery,
    Stopping,
}

impl State {
    fn report(
        self,
        sequence: u64,
        harness: i32,
        workspaces: &[String],
        profile: &HarnessExecutionProfile,
        disk: &DiskSpaceSource,
    ) -> ReportHostRequest {
        let (readiness, reason, available_slots) = match self {
            Self::Pending => (HostReadiness::Pending, HostReadinessReason::Starting, 0),
            Self::Ready => (HostReadiness::Ready, HostReadinessReason::Unspecified, 1),
            Self::Busy => (HostReadiness::Ready, HostReadinessReason::Unspecified, 0),
            Self::Recovery => (
                HostReadiness::Suppressed,
                HostReadinessReason::RecoveryRequired,
                0,
            ),
            Self::Stopping => (HostReadiness::Suppressed, HostReadinessReason::Stopping, 0),
        };
        ReportHostRequest {
            sequence,
            capacity: 1,
            available_slots,
            readiness: readiness as i32,
            reason: reason as i32,
            harness_kind: harness,
            workspace_ids: workspaces.to_vec(),
            execution_profile: Some(profile.clone()),
            disk_space: disk.sample(),
        }
    }
}

pub(crate) struct Presence {
    state: watch::Sender<State>,
    cancel: CancellationToken,
    task: Option<JoinHandle<Result<()>>>,
    journal: Arc<Journal>,
    client: RegisteredHost,
    token: String,
    harness: i32,
    workspaces: Vec<String>,
    profile: HarnessExecutionProfile,
    disk: DiskSpaceSource,
}

impl Presence {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start(
        journal: Arc<Journal>,
        disk: DiskSpaceSource,
        client: RegisteredHost,
        token: String,
        harness: i32,
        workspaces: Vec<String>,
        profile: HarnessExecutionProfile,
        shutdown: CancellationToken,
    ) -> Self {
        let cancel = shutdown.child_token();
        let (state, mut receiver) = watch::channel(State::Pending);
        let mut reporter = Self {
            state,
            cancel: cancel.clone(),
            task: None,
            journal: journal.clone(),
            client: client.clone(),
            token: token.clone(),
            harness,
            workspaces: workspaces.clone(),
            profile: profile.clone(),
            disk: disk.clone(),
        };
        reporter.task = Some(tokio::spawn(async move {
            let mut client = client;
            let mut ticker = tokio::time::interval(Duration::from_secs(5));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Ok(()),
                    changed = receiver.changed() => { if changed.is_err() { return Ok(()); } },
                    _ = ticker.tick() => {},
                }
                let state = *receiver.borrow_and_update();
                let sequence = match journal.next_report_sequence() {
                    Ok(sequence) => sequence,
                    Err(error) => {
                        shutdown.cancel();
                        return Err(error);
                    }
                };
                let report = state.report(sequence, harness, &workspaces, &profile, &disk);
                let response = tokio::select! {
                    _ = cancel.cancelled() => return Ok(()),
                    response = client.report_host(request(report, &token)?) => response,
                };
                if let Err(error) = response
                    && !retryable(&error)
                {
                    // Fencing/revocation also stops new local work. Native execution
                    // remains separately bounded by its own monotonic authority.
                    shutdown.cancel();
                    return Err(error.into());
                }
            }
        }));
        reporter
    }

    pub(crate) fn set(&self, state: State) {
        self.state.send_if_modified(|current| {
            if *current == state {
                false
            } else {
                *current = state;
                true
            }
        });
    }

    pub(crate) async fn stop(mut self) -> Result<()> {
        self.cancel.cancel();
        let result = match self.task.take() {
            Some(task) => task.await?,
            None => Ok(()),
        };
        let report = State::Stopping.report(
            self.journal.next_report_sequence()?,
            self.harness,
            &self.workspaces,
            &self.profile,
            &self.disk,
        );
        // Best effort: on a partition the last observation naturally expires. Never
        // prevent journal cleanup or treat a presence reply as execution authority.
        let _ = self.client.report_host(request(report, &self.token)?).await;
        result
    }
}

impl Drop for Presence {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
