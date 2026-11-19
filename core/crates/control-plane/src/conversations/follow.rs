//! Pushes a conversation's changes to the clients following it.
//!
//! Each follow subscribes to its Tag's notices on the replica's bus (see [`crate::bus`]) and reads
//! the conversation only when the tail delivers one, so an idle follow does no database work. The
//! database stays the truth: the tail reads the operator watch feed, where every change to a
//! conversation's messages or turns lands, whether or not its write published a hint.
use std::{
    collections::{HashMap, HashSet},
    hash::{Hash, Hasher},
    pin::Pin,
    time::Duration,
};

use prost::Message;
use supertag_protocol::v2::*;
use tokio::time::Instant;
use tokio_stream::Stream;
use tokio_util::sync::CancellationToken;
use tonic::Status;

use crate::{Store, StoreError, store::Result};

/// The most time between heartbeats.
const HEARTBEAT: Duration = Duration::from_secs(15);
/// How long a queued turn waits before the follow says why. Most turns start at once.
const WAIT_DELAY_MS: i64 = 2_000;
/// How often the follow reads again why a turn still waits.
const WAIT_EVERY: Duration = Duration::from_secs(3);
/// The most unfinished turns a follow refreshes, as ListMessages allows.
const TRACKED: usize = 128;

/// In-process signals for open follows, and the text of the messages running turns write.
pub(crate) struct Live {
    pub(crate) bus: crate::bus::Bus,
    text_changes: tokio::sync::watch::Sender<u64>,
    pub(crate) texts: super::texts::Texts,
    /// Worker Host claims held while they wait for a Task.
    pub(crate) claims: crate::claims::HeldClaims,
    /// When the sweeps that follow a claim last ran, in milliseconds since the epoch.
    pub(crate) claim_sweep: std::sync::atomic::AtomicI64,
    pub(crate) closing: CancellationToken,
}

impl Live {
    pub(crate) fn new(bus: crate::bus::Bus) -> Self {
        Self {
            bus,
            text_changes: tokio::sync::watch::Sender::new(0),
            texts: Default::default(),
            claims: Default::default(),
            claim_sweep: Default::default(),
            closing: CancellationToken::new(),
        }
    }
}

impl Live {
    pub(crate) fn texts_changed(&self) {
        self.text_changes
            .send_modify(|version| *version = version.wrapping_add(1));
    }
}

pub type Updates =
    Pin<Box<dyn Stream<Item = std::result::Result<FollowConversationResponse, Status>> + Send>>;

fn draining() -> Status {
    Status::unavailable("Control Plane is draining")
}

impl Store {
    /// Publishes a hint once the caller's write committed; see [`crate::bus::HintAfterCommit`].
    pub(crate) fn hint_after_commit(&self) -> crate::bus::HintAfterCommit {
        crate::bus::HintAfterCommit(self.live.clone())
    }

    /// Ends every open follow, as the Control Plane drains.
    pub fn close_follows(&self) {
        self.live.closing.cancel();
    }

    /// Follows `principal`'s conversation with a Tag; see `Conversations.FollowConversation`.
    pub async fn follow_conversation(
        &self,
        principal: &str,
        input: FollowConversationRequest,
    ) -> Result<Updates> {
        let mut read = ListMessagesRequest {
            tag_id: input.tag_id,
            limit: 0,
            cursor: String::new(),
            after: input.after,
            conversation_id: input.conversation_id,
            refresh_task_ids: input.refresh_task_ids,
        };
        // Subscribe, then read, then apply: notices at or below the head read before the first
        // page are already in it. Refuses what ListMessages refuses before the stream opens.
        let feed = self.follow_feed(&read.tag_id).await?;
        let mut seen = self.feed_head().await?;
        let first = self.list_messages(principal, &read).await?;
        let store = self.clone();
        let operator = principal.starts_with("operator:");
        let principal = principal.to_owned();
        let mut text_changes = self.live.text_changes.subscribe();
        let closing = self.live.closing.clone();
        let output = async_stream::try_stream! {
            let mut copy = Copy::default();
            let mut waits = Waits::default();
            let mut texts = TextsShown::default();
            let mut page = Some(first);
            let mut last_emit = Instant::now();
            let mut opened = false;
            loop {
                let mut response = FollowConversationResponse::default();
                if let Some(page) = page.take() {
                    response.messages = copy.update(&mut read, page);
                    if operator {
                        response.waits = waits.update(&store, &copy).await.map_err(Status::from)?;
                    }
                }
                response.texts = texts.update(&store.live.texts, &copy);
                if !opened
                    || response.messages.is_some()
                    || !response.waits.is_empty()
                    || !response.texts.is_empty()
                    || last_emit + HEARTBEAT <= Instant::now()
                {
                    opened = true;
                    last_emit = Instant::now();
                    yield response;
                }
                let wait_check = operator
                    .then(|| waits.next_check(&copy, store.execution_now_ms()))
                    .flatten();
                let deadline = (last_emit + HEARTBEAT)
                    .min(wait_check.unwrap_or_else(|| Instant::now() + HEARTBEAT));
                let wake = tokio::select! {
                    biased;
                    _ = closing.cancelled() => Wake::Draining,
                    wake = feed.wait() => Wake::Stored(wake),
                    _ = text_changes.changed() => Wake::Text,
                    _ = tokio::time::sleep_until(deadline) => Wake::Timer,
                };
                let changed = match wake {
                    Wake::Draining => Err(draining())?,
                    Wake::Stored(wake) => {
                        // A notice at or below what the last read started from is in it.
                        let changed = wake.gap || wake.through > seen;
                        seen = seen.max(wake.through);
                        changed
                    }
                    // Text the Tag is writing needs no read, unless its message was recorded:
                    // then the message and the cleared text go out together.
                    Wake::Text => texts.cleared(&store.live.texts),
                    Wake::Timer => false,
                };
                if changed || wait_check.is_some_and(|at| at <= Instant::now()) {
                    read.refresh_task_ids = copy.unfinished();
                    store.live.bus.stream_reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    page = Some(store.list_messages(&principal, &read).await.map_err(Status::from)?);
                }
            }
        };
        Ok(Box::pin(output))
    }
}

enum Wake {
    Draining,
    Stored(crate::bus::Wake),
    Text,
    Timer,
}

/// The version of each turn's text last sent.
#[derive(Default)]
struct TextsShown {
    sent: HashMap<String, u64>,
}

impl TextsShown {
    /// The text that changed of the client's running turns; empty text clears what was sent.
    fn update(&mut self, texts: &super::texts::Texts, copy: &Copy) -> Vec<TurnText> {
        let mut changed = Vec::new();
        let mut current = HashSet::new();
        for turn in copy.unfinished.iter().filter(|turn| !turn.queued) {
            let Some(shown) = texts.shown(&turn.task_id) else {
                continue;
            };
            current.insert(turn.task_id.as_str());
            if self.sent.insert(turn.task_id.clone(), shown.version) != Some(shown.version) {
                changed.push(TurnText {
                    task_id: turn.task_id.clone(),
                    after_sequence: shown.after_sequence,
                    text: shown.text,
                });
            }
        }
        let gone: Vec<String> = self
            .sent
            .keys()
            .filter(|id| !current.contains(id.as_str()))
            .cloned()
            .collect();
        for task_id in gone {
            self.sent.remove(&task_id);
            changed.push(TurnText {
                task_id,
                after_sequence: 0,
                text: String::new(),
            });
        }
        changed
    }

    /// Whether text sent before is gone, as when its message was recorded.
    fn cleared(&self, texts: &super::texts::Texts) -> bool {
        self.sent.keys().any(|id| texts.shown(id).is_none())
    }
}

/// What the client following holds: the conversation, the latest order, and a digest of each
/// message sent, so a read that finds a message unchanged sends nothing.
#[derive(Default)]
struct Copy {
    sent: HashMap<String, u64>,
    /// The unfinished turns the client holds, newest first.
    unfinished: Vec<Unfinished>,
}

impl Copy {
    /// What of `page` the client does not hold yet, and moves `read` past it.
    fn update(
        &mut self,
        read: &mut ListMessagesRequest,
        mut page: ListMessagesResponse,
    ) -> Option<ListMessagesResponse> {
        let replaced = !page.incremental;
        let mut changed = false;
        if replaced {
            // The page replaces the client's copy; it is sent when it differs from what was.
            let before = std::mem::take(&mut self.sent);
            changed =
                read.conversation_id != page.conversation_id || before.len() != page.messages.len();
            self.unfinished.clear();
            read.conversation_id = page.conversation_id.clone();
            read.after = 0;
            for message in &page.messages {
                let task_id = message.task.as_ref().map(|task| task.task_id.as_str());
                changed |= task_id.and_then(|id| before.get(id)) != Some(&digest(message));
            }
        }
        page.messages.retain(|message| {
            let Some(task) = &message.task else {
                return false;
            };
            let digest = digest(message);
            let new = self.sent.insert(task.task_id.clone(), digest) != Some(digest);
            self.unfinished.retain(|turn| turn.task_id != task.task_id);
            if !super::finished(task.state()) {
                self.unfinished.push(Unfinished {
                    task_id: task.task_id.clone(),
                    order: message.order,
                    sent_at_ms: message.sent_at_ms,
                    queued: task.state() == TaskState::Queued,
                    holder: task.waiting_for_holder.clone(),
                });
            }
            read.after = read.after.max(message.order);
            new || replaced
        });
        self.unfinished
            .sort_by_key(|turn| std::cmp::Reverse(turn.order));
        self.unfinished.truncate(TRACKED);
        let changed = if replaced {
            changed
        } else {
            !page.messages.is_empty()
        };
        changed.then_some(page)
    }

    fn unfinished(&self) -> Vec<String> {
        self.unfinished
            .iter()
            .map(|turn| turn.task_id.clone())
            .collect()
    }

    fn queued(&self) -> impl Iterator<Item = &Unfinished> {
        self.unfinished.iter().filter(|turn| turn.queued)
    }

    /// Running turns that wait for the Worker Host holding their Session's last delivery.
    fn waiting_for_holder(&self) -> impl Iterator<Item = (&Unfinished, &str)> {
        self.unfinished
            .iter()
            .filter_map(|turn| Some((turn, turn.holder.as_deref()?)))
    }
}

struct Unfinished {
    task_id: String,
    order: u64,
    sent_at_ms: i64,
    queued: bool,
    /// The Worker Host holding the Session's last delivery, which the running turn waits for.
    holder: Option<String>,
}

fn digest(message: &ConversationMessage) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    message.encode_to_vec().hash(&mut hasher);
    hasher.finish()
}

/// Why each queued turn waits, as last sent.
#[derive(Default)]
struct Waits {
    sent: HashMap<String, String>,
    checked: Option<Instant>,
}

impl Waits {
    /// The reasons that changed: a turn queued for a moment says why it waits, and a reason sent
    /// before is cleared once it no longer holds.
    async fn update(&mut self, store: &Store, copy: &Copy) -> Result<Vec<TurnWait>> {
        let now_ms = store.execution_now_ms();
        let mut current: HashSet<&str> = HashSet::new();
        let mut changed = Vec::new();
        // A running turn that waits for the holder of its Session's last delivery says so at once.
        for (turn, holder) in copy.waiting_for_holder() {
            let reason = supertag_protocol::waiting_for_holder(holder);
            current.insert(&turn.task_id);
            if self.sent.get(&turn.task_id) != Some(&reason) {
                self.sent.insert(turn.task_id.clone(), reason.clone());
                changed.push(TurnWait {
                    task_id: turn.task_id.clone(),
                    reason,
                });
            }
        }
        for turn in copy.queued() {
            let task_id = &turn.task_id;
            if turn.sent_at_ms + WAIT_DELAY_MS > now_ms {
                continue;
            }
            let diagnosis = match store.diagnose_task_placement(task_id).await {
                Ok(diagnosis) => diagnosis,
                Err(StoreError::NotFound(_)) => continue,
                Err(error) => Err(error)?,
            };
            let reason =
                if diagnosis.state() == TaskState::Queued && !diagnosis.requirement.is_empty() {
                    diagnosis.summary
                } else {
                    String::new()
                };
            if reason.is_empty() {
                continue;
            }
            current.insert(task_id);
            if self.sent.get(task_id) != Some(&reason) {
                self.sent.insert(task_id.clone(), reason.clone());
                changed.push(TurnWait {
                    task_id: task_id.clone(),
                    reason,
                });
            }
        }
        let cleared: Vec<String> = self
            .sent
            .keys()
            .filter(|id| !current.contains(id.as_str()))
            .cloned()
            .collect();
        for task_id in cleared {
            self.sent.remove(&task_id);
            changed.push(TurnWait {
                task_id,
                reason: String::new(),
            });
        }
        self.checked = Some(Instant::now());
        Ok(changed)
    }

    /// When to read again why turns wait: when a queued turn has waited a moment, and every few
    /// seconds while one that has stays queued.
    fn next_check(&self, copy: &Copy, now_ms: i64) -> Option<Instant> {
        let now = Instant::now();
        let mut next: Option<Instant> = None;
        for turn in copy.queued() {
            let due_ms = turn.sent_at_ms + WAIT_DELAY_MS;
            let at = if due_ms > now_ms {
                now + Duration::from_millis((due_ms - now_ms) as u64)
            } else {
                self.checked.map_or(now, |checked| checked + WAIT_EVERY)
            };
            next = Some(next.map_or(at, |next| next.min(at)));
        }
        if copy
            .waiting_for_holder()
            .any(|(turn, _)| !self.sent.contains_key(&turn.task_id))
        {
            next = Some(now);
        }
        if next.is_none() && !self.sent.is_empty() {
            // A reason sent before is cleared on the next read.
            next = Some(now);
        }
        next
    }
}
