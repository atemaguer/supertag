//! Pushes a conversation's changes to the clients following it.
//!
//! A write that can change a conversation signals [`Live`] after it commits. Each follow then
//! checks the operator watch feed for a notice about its Tag's Tasks or messages since it last
//! read, and reads only when there is one. The database stays the truth: a follow that misses a
//! signal finds the change on its next check, at most [`RECHECK`] later.
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
/// How often a follow checks the feed without a signal, for changes made outside a signalled
/// write, such as an expired Attempt lease.
const RECHECK: Duration = Duration::from_secs(2);
/// How long a queued turn waits before the follow says why. Most turns start at once.
const WAIT_DELAY_MS: i64 = 2_000;
/// How often the follow reads again why a turn still waits.
const WAIT_EVERY: Duration = Duration::from_secs(3);
/// The most unfinished turns a follow refreshes, as ListMessages allows.
const TRACKED: usize = 128;

/// In-process signals for open follows, and the text of the messages running turns write.
pub(crate) struct Live {
    changes: tokio::sync::watch::Sender<u64>,
    text_changes: tokio::sync::watch::Sender<u64>,
    pub(crate) texts: super::texts::Texts,
    closing: CancellationToken,
}

impl Default for Live {
    fn default() -> Self {
        Self {
            changes: tokio::sync::watch::Sender::new(0),
            text_changes: tokio::sync::watch::Sender::new(0),
            texts: Default::default(),
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

pub(crate) struct WakeFollows(std::sync::Arc<Live>);

impl Drop for WakeFollows {
    fn drop(&mut self) {
        self.0
            .changes
            .send_modify(|version| *version = version.wrapping_add(1));
    }
}

pub type Updates =
    Pin<Box<dyn Stream<Item = std::result::Result<FollowConversationResponse, Status>> + Send>>;

fn draining() -> Status {
    Status::unavailable("Control Plane is draining")
}

impl Store {
    /// Wakes the open follows when dropped. A write that can change a conversation holds one
    /// for its whole call, so the follows wake after it commits; one that fails wakes them for
    /// nothing, which costs one read of the feed's head.
    pub(crate) fn wake_follows(&self) -> WakeFollows {
        WakeFollows(self.live.clone())
    }

    /// Ends every open follow, as the Control Plane drains.
    pub fn close_follows(&self) {
        self.live.closing.cancel();
    }

    /// The feed's head, and whether a notice after `after` up to it concerns the Tag's Tasks or
    /// conversation messages. A position the feed no longer holds counts as a change.
    async fn conversation_changed_since(&self, tag_id: &str, after: i64) -> Result<(i64, bool)> {
        let (head, floor, found): (i64, i64, Option<i64>) = sqlx::query_as(
            "SELECT s.head, s.floor, (
                 SELECT n.position FROM supertag_v2_watch_notices n
                 WHERE n.position > $1 AND n.tag_id = $2 AND n.kind IN ($3, $4) LIMIT 1)
             FROM supertag_v2_watch_state s WHERE s.singleton = 1",
        )
        .bind(after)
        .bind(tag_id)
        .bind(WatchKind::Task as i64)
        .bind(WatchKind::ConversationMessage as i64)
        .fetch_one(&self.pool)
        .await?;
        Ok((head, found.is_some() || after < floor || after > head))
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
        // Refuses what ListMessages refuses before the stream opens.
        let (mut position, _) = self.conversation_changed_since(&read.tag_id, 0).await?;
        let first = self.list_messages(principal, &read).await?;
        let store = self.clone();
        let operator = principal.starts_with("operator:");
        let principal = principal.to_owned();
        let mut changes = self.live.changes.subscribe();
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
                    .min(Instant::now() + RECHECK)
                    .min(wait_check.unwrap_or_else(|| Instant::now() + HEARTBEAT));
                let wake = tokio::select! {
                    biased;
                    _ = closing.cancelled() => Wake::Draining,
                    _ = changes.changed() => Wake::Stored,
                    _ = text_changes.changed() => Wake::Text,
                    _ = tokio::time::sleep_until(deadline) => Wake::Timer,
                };
                match wake {
                    Wake::Draining => Err(draining())?,
                    // Text the Tag is writing needs no read, unless its message was recorded:
                    // then the message and the cleared text go out together.
                    Wake::Text if !texts.cleared(&store.live.texts) => continue,
                    _ => {}
                }
                let (head, changed) = store
                    .conversation_changed_since(&read.tag_id, position)
                    .await
                    .map_err(Status::from)?;
                position = head;
                if changed || wait_check.is_some_and(|at| at <= Instant::now()) {
                    read.refresh_task_ids = copy.unfinished();
                    page = Some(store.list_messages(&principal, &read).await.map_err(Status::from)?);
                }
            }
        };
        Ok(Box::pin(output))
    }
}

enum Wake {
    Draining,
    Stored,
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
}

struct Unfinished {
    task_id: String,
    order: u64,
    sent_at_ms: i64,
    queued: bool,
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
        if next.is_none() && !self.sent.is_empty() {
            // A reason sent before is cleared on the next read.
            next = Some(now);
        }
        next
    }
}
