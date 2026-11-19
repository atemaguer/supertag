//! Push after commit.
//!
//! A write that changes what streams show publishes a hint once it has committed. A hint carries
//! no content: whoever it wakes reads the store, so a lost hint costs latency and never data, and
//! a spurious one costs one read.
use std::sync::Arc;

use tokio::sync::Notify;

use crate::conversations::Live;

/// The in-process hint bus of one Control Plane replica.
pub(crate) struct Bus {
    /// Wakes whoever reads the store after a hint.
    hinted: Notify,
    /// Moves with every hint, for the Worker Host claims held while they wait for a Task.
    pub(crate) changes: tokio::sync::watch::Sender<u64>,
}

impl Default for Bus {
    fn default() -> Self {
        Self {
            hinted: Notify::new(),
            changes: tokio::sync::watch::Sender::new(0),
        }
    }
}

impl Bus {
    /// Something committed that streams may show. Call only after the commit.
    pub(crate) fn hint(&self) {
        self.changes
            .send_modify(|version| *version = version.wrapping_add(1));
        self.hinted.notify_one();
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
