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
        labels: &[String],
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
            labels: labels.to_vec(),
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
    labels: Vec<String>,
    reported: watch::Receiver<bool>,
}

/// Declared labels plus this machine's operating system and architecture.
/// Invalid or reserved declared labels fail at startup rather than at the
/// first report, which the Control Plane would refuse.
pub(crate) fn host_labels(declared: &[String]) -> Result<Vec<String>> {
    let os = match std::env::consts::OS {
        "macos" => Some("macos"),
        "linux" => Some("linux"),
        "windows" => Some("windows"),
        _ => None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => Some("x64"),
        "aarch64" => Some("arm64"),
        _ => None,
    };
    let mut labels = Vec::with_capacity(declared.len() + 2);
    for value in declared {
        let label = value.trim().to_ascii_lowercase();
        let bytes = label.as_bytes();
        anyhow::ensure!(
            value.is_ascii()
                && !bytes.is_empty()
                && bytes.len() <= 63
                && bytes[0].is_ascii_alphanumeric()
                && bytes.iter().all(|byte| byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || b".:_-".contains(byte)),
            "label {value:?} is invalid: a label is 1-63 lowercase letters, digits, dots, colons, hyphens, or underscores, starting with a letter or digit"
        );
        anyhow::ensure!(
            ![
                "mcp:",
                "mcp-login:",
                "volume-credential:",
                "artifact-volume:"
            ]
            .iter()
            .any(|prefix| label.starts_with(prefix)),
            "label {value:?} is reserved: the Control Plane derives it from host configuration"
        );
        labels.push(label);
    }
    labels.extend(os.into_iter().chain(arch).map(str::to_owned));
    labels.sort_unstable();
    labels.dedup();
    anyhow::ensure!(
        labels.len() <= MAX_LABELS,
        "a Worker Host carries at most {MAX_LABELS} labels, including its operating system and architecture"
    );
    Ok(labels)
}

/// The Control Plane's limit on reported labels.
const MAX_LABELS: usize = 64;

impl Presence {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start(
        journal: Arc<Journal>,
        disk: DiskSpaceSource,
        client: RegisteredHost,
        token: String,
        harness: i32,
        workspaces: Vec<String>,
        (profile, labels): (HarnessExecutionProfile, Vec<String>),
        shutdown: CancellationToken,
    ) -> Self {
        let cancel = shutdown.child_token();
        let (state, mut receiver) = watch::channel(State::Pending);
        let (reported_sender, reported) = watch::channel(false);
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
            labels: labels.clone(),
            reported,
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
                let report = state.report(sequence, harness, &workspaces, &profile, &disk, &labels);
                let response = tokio::select! {
                    _ = cancel.cancelled() => return Ok(()),
                    response = client.report_host(request(report, &token)?) => response,
                };
                if response.is_ok() {
                    reported_sender.send_replace(true);
                }
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

    /// Waits briefly for the first accepted report, so the Control Plane knows
    /// this host's labels before it places work on it.
    pub(crate) async fn first_report(&self, wait: Duration) {
        let mut reported = self.reported.clone();
        let _ = tokio::time::timeout(wait, reported.wait_for(|reported| *reported)).await;
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
            &self.labels,
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

#[cfg(test)]
mod label_tests {
    use super::host_labels;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn validates_declared_labels_before_the_first_report() {
        let labels = host_labels(&strings(&[" GPU ", "team:infra", "gpu"])).unwrap();
        assert!(labels.contains(&"gpu".to_owned()));
        assert!(labels.contains(&"team:infra".to_owned()));
        for invalid in [
            "gpu large",
            "-gpu",
            "mcp:github",
            "volume-credential:x",
            "gpü",
            "",
        ] {
            assert!(host_labels(&strings(&[invalid])).is_err(), "{invalid}");
        }
        // Operating system and architecture labels count toward the limit.
        let many: Vec<String> = (0..64).map(|index| format!("label-{index}")).collect();
        assert!(host_labels(&many).is_err());
        let fits: Vec<String> = (0..62).map(|index| format!("label-{index}")).collect();
        assert!(host_labels(&fits).is_ok());
    }
}
