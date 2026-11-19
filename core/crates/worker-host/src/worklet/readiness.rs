//! Presence runs independently of a Task's execution lease and native process: the Worklet
//! reports its pool, which its harnesses share, under the host's one registration.

use std::{sync::Arc, time::Duration};

use anyhow::Result;
use supertag_protocol::v2::{HarnessExecutionProfile, ReportHostRequest};
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::{
    RegisteredHost, environment::DiskSpaceSource, request, retryable, worklet::journal::Journal,
};

/// What one slot of the Worklet's Worker pool can do now. Presence aggregates them for the host
/// and each harness.
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

/// The slots of the Worker pool: which harness each holds and what it can do now, which presence
/// reports and `supertag ps` reads. It also shares the pool among the host's harnesses: a slot
/// with no Attempt or claim takes any harness below its limit, while the slots holding one never
/// outnumber the pool.
pub(crate) struct Slots {
    pool: std::sync::Mutex<Pool>,
    changed: tokio::sync::Notify,
    /// Notified when a slot lets go of its harness or the pool grows, so a slot waiting for room
    /// tries again.
    room: tokio::sync::Notify,
}

/// What a slot of the pool holds for its harness.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Hold {
    /// A claim journaled or held, which names no Attempt yet.
    Claim,
    /// An Attempt, from Starting until its local cleanup ends.
    Attempt,
}

/// One slot as presence sees it: the harness it holds, if any, and its state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SlotState {
    pub(crate) held: Option<(usize, Hold)>,
    pub(crate) state: State,
}

struct Pool {
    /// The pool's size: how many Task Attempts the host runs at once across its harnesses.
    total: u32,
    /// Each harness's own limit within the pool, by its index in the host's harnesses.
    limits: Vec<Option<u32>>,
    slots: std::collections::BTreeMap<String, SlotState>,
    /// The harness a tie goes to next, so slots that wait for work take turns.
    next: usize,
}

impl Pool {
    /// The harness a free `slot` claims for now: one below its own limit while the slots
    /// holding a harness are fewer than the pool, preferring the harness the fewest slots claim
    /// for, and taking turns among equals.
    fn choose(&mut self, slot: &str) -> Option<usize> {
        let others = || {
            self.slots
                .iter()
                .filter(move |(name, _)| name.as_str() != slot)
                .filter_map(|(_, state)| state.held)
        };
        if others().count() >= self.total as usize {
            return None;
        }
        let harnesses = self.limits.len();
        let chosen = (0..harnesses)
            .map(|offset| (self.next + offset) % harnesses)
            .filter(|&harness| {
                let held = others().filter(|(held, _)| *held == harness).count();
                self.limits[harness].is_none_or(|limit| held < limit as usize)
            })
            .min_by_key(|&harness| {
                others()
                    .filter(|held| *held == (harness, Hold::Claim))
                    .count()
            })?;
        self.next = (chosen + 1) % harnesses;
        Some(chosen)
    }
}

impl Slots {
    pub(crate) fn new(limits: Vec<Option<u32>>, total: u32) -> Self {
        Self {
            pool: std::sync::Mutex::new(Pool {
                total,
                limits,
                slots: std::collections::BTreeMap::new(),
                next: 0,
            }),
            changed: tokio::sync::Notify::new(),
            room: tokio::sync::Notify::new(),
        }
    }

    fn pool(&self) -> std::sync::MutexGuard<'_, Pool> {
        self.pool.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Changes the pool's size; a larger pool lets waiting slots claim.
    pub(crate) fn resize(&self, total: u32) {
        let mut pool = self.pool();
        if pool.total != total {
            pool.total = total;
            drop(pool);
            self.room.notify_waiters();
            self.changed.notify_one();
        }
    }

    pub(crate) fn set(&self, slot: &str, state: State) {
        let mut pool = self.pool();
        let entry = pool
            .slots
            .entry(slot.to_owned())
            .or_insert(SlotState { held: None, state });
        if entry.state != state {
            entry.state = state;
            drop(pool);
            self.changed.notify_one();
        }
    }

    /// Records that `slot`'s journal holds a claim or an Attempt of `harness`, whatever the
    /// limits: it was claimed already.
    pub(crate) fn hold(&self, slot: &str, harness: usize, hold: Hold) {
        let mut pool = self.pool();
        let entry = pool.slots.entry(slot.to_owned()).or_insert(SlotState {
            held: None,
            state: State::Pending,
        });
        if entry.held != Some((harness, hold)) {
            entry.held = Some((harness, hold));
            drop(pool);
            self.changed.notify_one();
        }
    }

    /// The harness `slot`, which holds nothing, claims for next, recorded as its claim; `None`
    /// when the pool is full or every harness is at its own limit.
    pub(crate) fn choose(&self, slot: &str) -> Option<usize> {
        let mut pool = self.pool();
        let chosen = pool.choose(slot)?;
        pool.slots
            .entry(slot.to_owned())
            .or_insert(SlotState {
                held: None,
                state: State::Pending,
            })
            .held = Some((chosen, Hold::Claim));
        drop(pool);
        self.changed.notify_one();
        Some(chosen)
    }

    /// Records that `slot` holds nothing now, so another slot may claim for its harness.
    pub(crate) fn release(&self, slot: &str) {
        let released = self
            .pool()
            .slots
            .get_mut(slot)
            .and_then(|state| state.held.take())
            .is_some();
        if released {
            self.room.notify_waiters();
            self.changed.notify_one();
        }
    }

    /// Waits until a slot lets go of its harness or the pool grows. Create it before
    /// [`Self::choose`] finds no room, so a release in between is not missed.
    pub(crate) fn room(&self) -> tokio::sync::futures::Notified<'_> {
        self.room.notified()
    }

    /// Forgets a slot a lowered pool size retired.
    pub(crate) fn remove(&self, slot: &str) {
        let removed = self.pool().slots.remove(slot);
        if let Some(removed) = removed {
            if removed.held.is_some() {
                self.room.notify_waiters();
            }
            self.changed.notify_one();
        }
    }

    /// The pool's size and each slot's state.
    pub(crate) fn snapshot(&self) -> (u32, Vec<SlotState>) {
        let pool = self.pool();
        (pool.total, pool.slots.values().copied().collect())
    }

    pub(crate) fn any_busy(&self) -> bool {
        self.snapshot()
            .1
            .iter()
            .any(|slot| slot.state == State::Busy)
    }

    pub(crate) fn notify(&self) {
        self.changed.notify_one();
    }
}

/// One harness the pool runs: its kind, the execution profile it reports now, and its own limit
/// within the pool, if any.
pub(crate) struct Harness {
    pub(crate) kind: supertag_protocol::v2::HarnessKind,
    pub(crate) profile: Profile,
    pub(crate) limit: Option<u32>,
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
    pub(crate) fn start(
        journal: Arc<Journal>,
        disk: DiskSpaceSource,
        (client, token): (RegisteredHost, String),
        harnesses: Vec<Harness>,
        (workspaces, labels): (Vec<String>, Vec<String>),
        slots: Arc<Slots>,
        shutdown: CancellationToken,
    ) -> Self {
        let cancel = shutdown.child_token();
        let (reported_sender, reported) = watch::channel(false);
        let build = {
            let slots = slots.clone();
            move |stopping: bool| -> Result<ReportHostRequest> {
                let sequence = journal.next_report_sequence()?;
                let entries = harnesses
                    .iter()
                    .map(|harness| crate::worklet::shared_host::HarnessSlots {
                        harness: harness.kind,
                        profile: (harness.profile)(),
                        limit: harness.limit,
                    })
                    .collect::<Vec<_>>();
                let (total, mut states) = slots.snapshot();
                if stopping {
                    for slot in &mut states {
                        slot.state = State::Stopping;
                    }
                }
                let mut report = crate::worklet::shared_host::aggregate(
                    sequence,
                    (total, &entries),
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
        reporter.task = Some(tokio::spawn(async move {
            let mut client = client;
            let mut ticker = tokio::time::interval(Duration::from_secs(5));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Ok(()),
                    () = slots.changed.notified() => {},
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

#[cfg(test)]
mod pool_tests {
    use super::{Hold, Slots, State};

    /// How many slots hold each harness, for `harnesses` harnesses.
    fn held(slots: &Slots, harnesses: usize) -> Vec<usize> {
        let (_, states) = slots.snapshot();
        (0..harnesses)
            .map(|harness| {
                states
                    .iter()
                    .filter(|slot| slot.held.is_some_and(|(held, _)| held == harness))
                    .count()
            })
            .collect()
    }

    #[test]
    fn the_pool_and_each_harness_limit_are_never_exceeded() {
        // Three slots; the second harness may run one Attempt at most.
        let slots = Slots::new(vec![None, Some(1)], 3);
        let chosen: Vec<_> = ["0", "1", "2"]
            .iter()
            .map(|slot| slots.choose(slot))
            .collect();
        assert_eq!(chosen, [Some(0), Some(1), Some(0)]);
        assert_eq!(held(&slots, 2), [2, 1]);
        // A fourth slot, left over from a larger pool, gets nothing: the pool is full.
        assert_eq!(slots.choose("3"), None);
        // A Claim that became an Attempt still counts against both.
        slots.hold("1", 1, Hold::Attempt);
        slots.release("0");
        // Only the first harness has room; the second is at its limit.
        assert_eq!(slots.choose("0"), Some(0));
        assert_eq!(slots.choose("3"), None);
        // Choosing again for a slot replaces its own hold rather than adding to it.
        slots.release("2");
        assert_eq!(slots.choose("2"), Some(0));
        assert_eq!(held(&slots, 2), [2, 1]);
    }

    #[test]
    fn an_idle_harness_leaves_its_share_to_the_others() {
        let slots = Slots::new(vec![None, None], 3);
        // Every slot runs the first harness while the second has no work.
        for slot in ["0", "1", "2"] {
            slots.hold(slot, 0, Hold::Attempt);
        }
        assert_eq!(held(&slots, 2), [3, 0]);
        assert_eq!(slots.choose("3"), None);
        // One finishes: its slot claims for each harness in turn until one has work.
        slots.release("2");
        let first = slots.choose("2").unwrap();
        slots.release("2");
        assert_ne!(slots.choose("2"), Some(first));
    }

    #[test]
    fn a_free_slot_takes_turns_among_harnesses_waiting_for_work() {
        let slots = Slots::new(vec![None, None, None], 1);
        let mut chosen = Vec::new();
        for _ in 0..4 {
            chosen.push(slots.choose("0").unwrap());
            // Its claim found no work.
            slots.release("0");
        }
        assert_eq!(chosen, [0, 1, 2, 0]);
        // With more slots than harnesses, every harness holds a claim before any holds two.
        let slots = Slots::new(vec![None, None], 3);
        slots.hold("0", 0, Hold::Claim);
        assert_eq!(slots.choose("1"), Some(1));
        assert_eq!(slots.choose("2"), Some(0));
    }

    #[test]
    fn resizing_changes_what_free_slots_may_claim() {
        let slots = Slots::new(vec![None], 2);
        slots.hold("0", 0, Hold::Attempt);
        slots.hold("1", 0, Hold::Attempt);
        // Lowered while both run: neither the retiring slot nor slot 0 claims until one ends.
        slots.resize(1);
        slots.release("0");
        assert_eq!(slots.choose("0"), None);
        slots.remove("1");
        assert_eq!(slots.choose("0"), Some(0));
        slots.resize(3);
        assert_eq!(slots.choose("1"), Some(0));
        assert_eq!(slots.choose("2"), Some(0));
        assert_eq!(slots.snapshot().0, 3);
    }

    #[tokio::test]
    async fn a_released_harness_wakes_a_slot_waiting_for_room() {
        let slots = std::sync::Arc::new(Slots::new(vec![Some(1)], 2));
        assert_eq!(slots.choose("0"), Some(0));
        let room = slots.room();
        assert_eq!(slots.choose("1"), None);
        slots.set("1", State::Ready);
        slots.release("0");
        tokio::time::timeout(std::time::Duration::from_secs(1), room)
            .await
            .expect("the release wakes the waiting slot");
        assert_eq!(slots.choose("1"), Some(0));
    }
}
