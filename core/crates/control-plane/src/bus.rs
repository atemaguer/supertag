//! Push after commit.
//!
//! A write that changes what streams show publishes a hint once it has committed. A hint carries
//! no content: whoever it wakes reads the store, so a lost hint costs latency and never data, and
//! a spurious one costs one read.
//!
//! One tail per Control Plane replica reads the operator watch feed, where every conversation
//! message, Task event, Task result, and watch notice lands, and fans each new notice out to the
//! streams subscribed to it: a conversation follow by its Tag, an operator Watch by its scope. A
//! hint wakes the tail; without one it reads every [`Bus::poll`] anyway. Streams read the store
//! only when the tail tells them something they follow changed, so an idle stream costs nothing.
//! On PostgreSQL the tail also listens for the hints other replicas' commits send (see
//! [`listener`]); SQLite runs in one process, where the in-process hints are enough.
//!
//! A stream subscribes first, then reads its history, then applies what the tail delivered since,
//! dropping anything at or below what its read returned. A subscription registered while the
//! tail stood at position P receives every notice after P, and the stream's own read, made later,
//! sees at least through P, so nothing falls between them.
//!
//! The text a running turn's Tag is writing travels the same bus as an ephemeral signal, to the
//! follows of that Tag on the replica that received it; it is never stored.
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    },
    time::Duration,
};

use supertag_protocol::v2::WatchKind;
use tokio::sync::{Notify, mpsc};

pub(crate) mod listener;

use crate::{
    Store,
    conversations::Live,
    store::Result,
    watch::{Notice, PAGE_SIZE},
};

/// How long the tail waits for a hint before it reads anyway, on PostgreSQL. Every committed
/// write there that records a notice also notifies, so the poll only covers a lost notification.
const POSTGRES_POLL: Duration = Duration::from_secs(1);
/// The same on SQLite, which has no notifications and where some writes publish no hint. One
/// indexed read per process, however many streams are open.
const SQLITE_POLL: Duration = Duration::from_millis(250);
/// The most notices one Watch holds undelivered. A Watch further behind reads the store instead.
pub(crate) const QUEUE: usize = 1024;

/// The in-process hint bus of one Control Plane replica, and its tail.
pub(crate) struct Bus {
    state: Mutex<State>,
    /// Wakes the tail.
    hinted: Notify,
    /// Moves with every hint, for the Worker Host claims held while they wait for a Task.
    pub(crate) changes: tokio::sync::watch::Sender<u64>,
    poll_ms: AtomicU64,
    /// Where the tail listens for other replicas' commits, on PostgreSQL.
    listen: Option<sqlx::postgres::PgConnectOptions>,
    /// Keeps the listener from reconnecting, for tests of the poll.
    #[cfg(test)]
    pub(crate) listener_paused: AtomicBool,
    /// Reads the tail made, for tests that check streams leave reading to it.
    pub(crate) tail_reads: AtomicU64,
    /// Reads streams made after their first, for the same tests.
    pub(crate) stream_reads: AtomicU64,
}

#[derive(Default)]
struct State {
    next: u64,
    /// The position of the last notice the running tail delivered; none while no tail runs.
    tail: Option<i64>,
    follows: HashMap<String, HashMap<u64, Arc<Signal>>>,
    watches: HashMap<u64, WatchSink>,
}

/// What an operator Watch is sent: a notice its scope may show, or a gap after which it reads the
/// store from its own position.
pub(crate) enum Delivery {
    Notice(Arc<Notice>),
    Gap,
}

struct WatchSink {
    /// Whether a notice is in the Watch's scope. The Watch checks again what needs the store.
    passes: Box<dyn Fn(&Notice) -> bool + Send + Sync>,
    queue: mpsc::Sender<Delivery>,
    lagged: Arc<AtomicBool>,
}

impl WatchSink {
    fn send(&self, delivery: Delivery) {
        if self.queue.try_send(delivery).is_err() {
            self.lagged.store(true, Ordering::SeqCst);
        }
    }
}

/// What woke a follow.
#[derive(Default)]
pub(crate) struct Signal {
    /// The latest position of a notice about the followed Tag; zero for none since last taken.
    through: AtomicI64,
    /// The tail skipped notices the feed no longer holds.
    gap: AtomicBool,
    /// The text the Tag's running turns are writing changed.
    text: AtomicBool,
    notify: Notify,
}

pub(crate) struct Wake {
    pub(crate) through: i64,
    pub(crate) gap: bool,
    pub(crate) text: bool,
}

impl Signal {
    fn feed(&self, position: i64) {
        self.through.fetch_max(position, Ordering::SeqCst);
        self.notify.notify_one();
    }

    fn gap(&self) {
        self.gap.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }

    fn text(&self) {
        self.text.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }

    fn take(&self) -> Option<Wake> {
        let wake = Wake {
            through: self.through.swap(0, Ordering::SeqCst),
            gap: self.gap.swap(false, Ordering::SeqCst),
            text: self.text.swap(false, Ordering::SeqCst),
        };
        (wake.through > 0 || wake.gap || wake.text).then_some(wake)
    }
}

impl Bus {
    pub(crate) fn new(listen: Option<sqlx::postgres::PgConnectOptions>) -> Self {
        Self {
            state: Mutex::default(),
            hinted: Notify::new(),
            changes: tokio::sync::watch::Sender::new(0),
            poll_ms: AtomicU64::new(
                if listen.is_some() {
                    POSTGRES_POLL
                } else {
                    SQLITE_POLL
                }
                .as_millis() as u64,
            ),
            listen,
            #[cfg(test)]
            listener_paused: AtomicBool::new(false),
            tail_reads: AtomicU64::new(0),
            stream_reads: AtomicU64::new(0),
        }
    }

    /// Something committed that streams may show. Call only after the commit.
    pub(crate) fn hint(&self) {
        self.changes
            .send_modify(|version| *version = version.wrapping_add(1));
        self.hinted.notify_one();
    }

    /// How long the tail waits for a hint before it reads anyway.
    pub(crate) fn poll(&self) -> Duration {
        Duration::from_millis(self.poll_ms.load(Ordering::Relaxed))
    }

    #[cfg(test)]
    pub(crate) fn set_poll(&self, poll: Duration) {
        self.poll_ms
            .store(poll.as_millis() as u64, Ordering::Relaxed);
    }

    /// The text a running turn of `tag_id` is writing changed: wakes the follows of that Tag's
    /// conversations on this replica. Text is an ephemeral signal: it never touches the store and
    /// reaches no other replica, where the recorded message arrives on commit instead.
    pub(crate) fn text(&self, tag_id: &str) {
        let state = self.state.lock().unwrap();
        for signal in state
            .follows
            .get(tag_id)
            .into_iter()
            .flat_map(HashMap::values)
        {
            signal.text();
        }
    }

    fn unsubscribe(&self, remove: impl FnOnce(&mut State)) {
        let mut state = self.state.lock().unwrap();
        remove(&mut state);
        if state.is_empty() {
            // The tail stops on its next turn.
            self.hinted.notify_one();
        }
    }
}

impl State {
    fn is_empty(&self) -> bool {
        self.follows.is_empty() && self.watches.is_empty()
    }

    /// Fans out what the tail read after `after`.
    fn deliver(&mut self, after: i64, page: crate::watch::Page) {
        let mut position = after;
        if after < page.floor || after > page.head {
            // Notices between were pruned, or the feed is not the one the tail read.
            for signal in self.follows.values().flat_map(HashMap::values) {
                signal.gap();
            }
            for watch in self.watches.values() {
                watch.send(Delivery::Gap);
            }
            position = page.floor.min(page.head);
        }
        for notice in page.notices {
            position = notice.position;
            let notice = Arc::new(notice);
            let kind = notice.change.kind;
            if kind == WatchKind::Task as i32 || kind == WatchKind::ConversationMessage as i32 {
                for signal in self
                    .follows
                    .get(&notice.change.tag_id)
                    .into_iter()
                    .flat_map(HashMap::values)
                {
                    signal.feed(notice.position);
                }
            }
            for watch in self.watches.values() {
                if (watch.passes)(&notice) {
                    watch.send(Delivery::Notice(notice.clone()));
                }
            }
        }
        self.tail = Some(position);
    }
}

/// A conversation follow's subscription to its Tag's notices and the text its turns write.
pub(crate) struct FollowFeed {
    live: Arc<Live>,
    tag_id: String,
    id: u64,
    signal: Arc<Signal>,
}

impl FollowFeed {
    /// Waits for the next change to the followed Tag's conversations.
    pub(crate) async fn wait(&self) -> Wake {
        loop {
            if let Some(wake) = self.signal.take() {
                return wake;
            }
            self.signal.notify.notified().await;
        }
    }
}

impl Drop for FollowFeed {
    fn drop(&mut self) {
        self.live.bus.unsubscribe(|state| {
            if let Some(follows) = state.follows.get_mut(&self.tag_id) {
                follows.remove(&self.id);
                if follows.is_empty() {
                    state.follows.remove(&self.tag_id);
                }
            }
        });
    }
}

/// An operator Watch's subscription to the notices in its scope.
pub(crate) struct WatchFeed {
    live: Arc<Live>,
    id: u64,
    queue: mpsc::Receiver<Delivery>,
    lagged: Arc<AtomicBool>,
}

impl WatchFeed {
    /// The next delivery. A Watch that fell more than [`QUEUE`] notices behind gets a gap.
    pub(crate) async fn next(&mut self) -> Delivery {
        let delivery = self.queue.recv().await.unwrap_or(Delivery::Gap);
        if self.lagged.swap(false, Ordering::SeqCst) {
            Delivery::Gap
        } else {
            delivery
        }
    }

    /// The next delivery already waiting, if any.
    pub(crate) fn try_next(&mut self) -> Option<Delivery> {
        let delivery = self.queue.try_recv().ok()?;
        if self.lagged.swap(false, Ordering::SeqCst) {
            Some(Delivery::Gap)
        } else {
            Some(delivery)
        }
    }
}

impl WatchFeed {
    /// The position through which the tail delivered everything this Watch may show, when the
    /// Watch has taken all of it.
    pub(crate) fn passed(&self) -> Option<i64> {
        let state = self.live.bus.state.lock().unwrap();
        // Under the lock the tail delivers nothing more, so an empty queue is all taken.
        (self.queue.is_empty() && !self.lagged.load(Ordering::SeqCst))
            .then_some(state.tail)
            .flatten()
    }
}

impl Drop for WatchFeed {
    fn drop(&mut self) {
        self.live.bus.unsubscribe(|state| {
            state.watches.remove(&self.id);
        });
    }
}

impl Store {
    /// Subscribes to the notices about `tag_id`'s conversations and the text its turns write.
    pub(crate) async fn follow_feed(&self, tag_id: &str) -> Result<FollowFeed> {
        let signal = Arc::new(Signal::default());
        let id = self
            .subscribe(|state, id| {
                state
                    .follows
                    .entry(tag_id.to_owned())
                    .or_default()
                    .insert(id, signal.clone());
            })
            .await?;
        Ok(FollowFeed {
            live: self.live.clone(),
            tag_id: tag_id.to_owned(),
            id,
            signal,
        })
    }

    /// Subscribes to the notices `passes` lets through.
    pub(crate) async fn watch_feed(
        &self,
        passes: impl Fn(&Notice) -> bool + Send + Sync + 'static,
    ) -> Result<WatchFeed> {
        let (sender, queue) = mpsc::channel(QUEUE);
        let lagged = Arc::new(AtomicBool::new(false));
        let sink = WatchSink {
            passes: Box::new(passes),
            queue: sender,
            lagged: lagged.clone(),
        };
        let id = self
            .subscribe(|state, id| {
                state.watches.insert(id, sink);
            })
            .await?;
        Ok(WatchFeed {
            live: self.live.clone(),
            id,
            queue,
            lagged,
        })
    }

    /// Registers a subscription, starting the tail if none runs.
    async fn subscribe(&self, register: impl FnOnce(&mut State, u64)) -> Result<u64> {
        let bus = &self.live.bus;
        let running = |state: &State| state.tail.is_some() || self.live.closing.is_cancelled();
        {
            let mut state = bus.state.lock().unwrap();
            if running(&state) {
                state.next += 1;
                let id = state.next;
                register(&mut state, id);
                return Ok(id);
            }
        }
        // A tail started here delivers every notice after the head read now, before the caller
        // reads its history.
        let head = self.feed_head().await?;
        let mut state = bus.state.lock().unwrap();
        state.next += 1;
        let id = state.next;
        register(&mut state, id);
        if !running(&state) {
            state.tail = Some(head);
            tokio::spawn(tail(self.clone()));
        }
        Ok(id)
    }
}

/// Reads the operator watch feed once for every stream on this replica, until none is open.
async fn tail(store: Store) {
    let live = store.live.clone();
    let bus = &live.bus;
    let stop = live.closing.child_token();
    let _stopped = stop.clone().drop_guard();
    if let Some(options) = &bus.listen {
        tokio::spawn(listener::listen(
            options.clone(),
            live.clone(),
            stop.clone(),
        ));
    }
    loop {
        // Everything after the last notice delivered.
        loop {
            let Some(after) = bus.state.lock().unwrap().tail else {
                return;
            };
            let Ok(page) = store.watch_page(after).await else {
                break;
            };
            bus.tail_reads.fetch_add(1, Ordering::Relaxed);
            let more = page.notices.len() as i64 >= PAGE_SIZE;
            let delivered = !page.notices.is_empty();
            {
                let mut state = bus.state.lock().unwrap();
                if state.is_empty() {
                    state.tail = None;
                    return;
                }
                state.deliver(after, page);
            }
            if delivered {
                // Held claims check the feed's head themselves.
                bus.changes
                    .send_modify(|version| *version = version.wrapping_add(1));
            }
            if !more {
                break;
            }
        }
        tokio::select! {
            _ = stop.cancelled() => {}
            _ = bus.hinted.notified() => {}
            _ = tokio::time::sleep(bus.poll()) => {}
        }
        let mut state = bus.state.lock().unwrap();
        if stop.is_cancelled() || state.is_empty() {
            state.tail = None;
            return;
        }
    }
}

/// Publishes a hint when dropped. A write that can change what streams show holds one for its
/// whole call, so the hint goes out only after the call's transactions committed; one that
/// failed publishes it for nothing.
pub(crate) struct HintAfterCommit(pub(crate) Arc<Live>);

impl Drop for HintAfterCommit {
    fn drop(&mut self) {
        self.0.bus.hint();
    }
}

#[cfg(test)]
mod tests;
