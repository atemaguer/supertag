//! Presence runs independently of a Task's execution lease and native process: the Worklet
//! reports its pool's slots per harness under the host's one registration.

use std::{sync::Arc, time::Duration};

use anyhow::Result;
use supertag_protocol::v2::{HarnessExecutionProfile, ReportHostRequest};
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::{
    RegisteredHost, environment::DiskSpaceSource, request, retryable, worklet::journal::Journal,
};

/// What one slot of the Worklet's Worker pool can do now. Presence aggregates them per harness.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Pending,
    Ready,
    Busy,
    Recovery,
    Stopping,
}

/// This machine and user's identifier, read once. Empty when it can't be read or created, so
/// clients simply can't read this host's Task files from its disk.
pub(crate) fn machine_id() -> String {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| supertag_local_state::machine_id().unwrap_or_default())
        .clone()
}

/// The slots of the Worker pool and their states, which presence reports and `supertag ps`
/// reads.
#[derive(Default)]
pub(crate) struct Slots {
    states: std::sync::Mutex<std::collections::BTreeMap<String, (usize, State)>>,
    changed: tokio::sync::Notify,
}

impl Slots {
    pub(crate) fn set(&self, slot: &str, harness: usize, state: State) {
        let mut states = self
            .states
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if states.get(slot) != Some(&(harness, state)) {
            states.insert(slot.to_owned(), (harness, state));
            drop(states);
            self.changed.notify_one();
        }
    }

    /// Forgets a slot a lowered pool size retired.
    pub(crate) fn remove(&self, slot: &str) {
        let removed = self
            .states
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(slot)
            .is_some();
        if removed {
            self.changed.notify_one();
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<(String, usize, State)> {
        self.states
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(name, (harness, state))| (name.clone(), *harness, *state))
            .collect()
    }

    pub(crate) fn any_busy(&self) -> bool {
        self.snapshot()
            .iter()
            .any(|(_, _, state)| *state == State::Busy)
    }

    pub(crate) fn notify(&self) {
        self.changed.notify_one();
    }
}

/// One harness the pool runs: its kind, the execution profile it reports now, and its slots.
pub(crate) struct Harness {
    pub(crate) kind: supertag_protocol::v2::HarnessKind,
    pub(crate) profile: Profile,
}

pub(crate) struct Presence {
    cancel: CancellationToken,
    task: Option<JoinHandle<Result<()>>>,
    report: Arc<dyn Fn(bool) -> Result<ReportHostRequest> + Send + Sync>,
    client: RegisteredHost,
    token: String,
    reported: watch::Receiver<bool>,
}

/// Declared labels plus this machine's operating system and architecture.
/// Invalid or reserved declared labels fail at startup rather than at the
/// first report, which the Control Plane would refuse.
pub fn host_labels(declared: &[String]) -> Result<Vec<String>> {
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
            !["mcp:", "mcp-login:", "volume-credential:", "volume:"]
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

/// The execution profile to report now; MCP login states change while the host runs.
pub(crate) type Profile = Arc<dyn Fn() -> HarnessExecutionProfile + Send + Sync>;

impl Presence {
    /// Reports the host's presence whenever a slot changes state or the pool size changes, and
    /// at least every five seconds. A fenced or revoked registration cancels `shutdown`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start(
        journal: Arc<Journal>,
        disk: DiskSpaceSource,
        client: RegisteredHost,
        token: String,
        (harnesses, capacity): (Vec<Harness>, watch::Receiver<u32>),
        (workspaces, labels): (Vec<String>, Vec<String>),
        slots: Arc<Slots>,
        shutdown: CancellationToken,
    ) -> Self {
        let cancel = shutdown.child_token();
        let (reported_sender, reported) = watch::channel(false);
        let build = {
            let slots = slots.clone();
            let capacity = capacity.clone();
            move |stopping: bool| -> Result<ReportHostRequest> {
                let sequence = journal.next_report_sequence()?;
                let capacity = *capacity.borrow();
                let entries = harnesses
                    .iter()
                    .map(|harness| crate::worklet::shared_host::HarnessSlots {
                        harness: harness.kind,
                        profile: (harness.profile)(),
                        capacity,
                    })
                    .collect::<Vec<_>>();
                let states = slots
                    .snapshot()
                    .into_iter()
                    .map(|(_, harness, state)| {
                        (harness, if stopping { State::Stopping } else { state })
                    })
                    .collect::<Vec<_>>();
                let mut report = crate::worklet::shared_host::aggregate(
                    sequence,
                    &entries,
                    &states,
                    &workspaces,
                );
                report.labels = labels.clone();
                report.disk_space = disk.sample();
                report.machine_id = machine_id();
                Ok(report)
            }
        };
        let build: Arc<dyn Fn(bool) -> Result<ReportHostRequest> + Send + Sync> = Arc::new(build);
        let mut reporter = Self {
            cancel: cancel.clone(),
            task: None,
            report: build.clone(),
            client: client.clone(),
            token: token.clone(),
            reported,
        };
        let mut capacity = capacity;
        reporter.task = Some(tokio::spawn(async move {
            let mut client = client;
            let mut ticker = tokio::time::interval(Duration::from_secs(5));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Ok(()),
                    () = slots.changed.notified() => {},
                    changed = capacity.changed() => { if changed.is_err() { return Ok(()); } },
                    _ = ticker.tick() => {},
                }
                let report = match build(false) {
                    Ok(report) => report,
                    Err(error) => {
                        shutdown.cancel();
                        return Err(error);
                    }
                };
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

    /// Whether a report was accepted yet, so the Control Plane knows this host's labels before
    /// it places work on it.
    pub(crate) fn reported(&self) -> watch::Receiver<bool> {
        self.reported.clone()
    }

    pub(crate) async fn stop(mut self) -> Result<()> {
        self.cancel.cancel();
        let result = match self.task.take() {
            Some(task) => task.await?,
            None => Ok(()),
        };
        let report = (self.report)(true)?;
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
