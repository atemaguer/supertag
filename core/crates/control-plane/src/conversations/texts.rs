//! The text of the messages running turns are writing, kept in memory only.
//!
//! A Worker Host sends the redacted text so far of the message its Attempt's Tag is writing. It
//! is shown to the turn's conversation until the message is recorded as an event or the turn
//! finishes, and is never stored: a restarted Control Plane loses it, and the recorded message
//! still lands. It reaches the follows of the turn's Tag on this replica over the bus; a follow on
//! another replica sees only the recorded message, as it commits.
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use supertag_protocol::v2::*;

use crate::{Store, StoreError, store::Result};

/// The most text kept for one message; the recorded message has the rest.
const MAX_TEXT_BYTES: usize = 64 * 1024;
/// How long text nobody updated or cleared is kept, as when its Worker Host vanished.
const ABANDONED: Duration = Duration::from_secs(600);

#[derive(Default)]
pub(crate) struct Texts {
    turns: Mutex<HashMap<String, Turn>>,
    next_version: Mutex<u64>,
}

/// One running turn's text.
struct Turn {
    /// The Tag whose conversation the turn is in, whose follows the text reaches.
    tag_id: String,
    /// The latest message event recorded for the turn: text written before it is that message.
    recorded_through: u64,
    after_sequence: u64,
    revision: u64,
    text: String,
    /// Changes whenever what a follow shows of the turn changes.
    version: u64,
    updated: Instant,
}

/// What a follow shows of a turn's text, and its version.
pub(crate) struct Shown {
    pub version: u64,
    pub after_sequence: u64,
    pub text: String,
}

impl Texts {
    fn version(&self) -> u64 {
        let mut next = self.next_version.lock().unwrap();
        *next += 1;
        *next
    }

    /// Records text; it says whether what a follow shows changed.
    fn set(&self, tag_id: &str, task_id: &str, input: &PublishTaskTextRequest) -> bool {
        let version = self.version();
        let mut text = input.text.clone();
        if text.len() > MAX_TEXT_BYTES {
            let mut end = MAX_TEXT_BYTES;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        let mut turns = self.turns.lock().unwrap();
        turns.retain(|_, turn| turn.updated.elapsed() < ABANDONED);
        let turn = turns.entry(task_id.to_owned()).or_insert(Turn {
            tag_id: tag_id.to_owned(),
            recorded_through: 0,
            after_sequence: input.after_sequence,
            revision: 0,
            text: String::new(),
            version,
            updated: Instant::now(),
        });
        // Text of a message already recorded, or older than what is shown, is stale.
        if input.after_sequence < turn.recorded_through
            || input.after_sequence < turn.after_sequence
            || (input.after_sequence == turn.after_sequence
                && input.revision <= turn.revision
                && !turn.text.is_empty())
        {
            return false;
        }
        turn.updated = Instant::now();
        turn.revision = input.revision;
        if turn.after_sequence == input.after_sequence && turn.text == text {
            return false;
        }
        turn.after_sequence = input.after_sequence;
        turn.text = text;
        turn.version = version;
        true
    }

    /// The turn recorded message event `sequence`: text written before it is that message. The
    /// Tag whose follows see the text cleared, if it was.
    fn recorded(&self, task_id: &str, sequence: u64) -> Option<String> {
        let version = self.version();
        let mut turns = self.turns.lock().unwrap();
        let turn = turns.get_mut(task_id)?;
        turn.recorded_through = turn.recorded_through.max(sequence);
        if turn.after_sequence >= sequence || turn.text.is_empty() {
            return None;
        }
        turn.text.clear();
        turn.version = version;
        Some(turn.tag_id.clone())
    }

    /// The turn finished; its result replaces any text. The Tag whose follows saw text, if any.
    fn forget(&self, task_id: &str) -> Option<String> {
        self.turns
            .lock()
            .unwrap()
            .remove(task_id)
            .filter(|turn| !turn.text.is_empty())
            .map(|turn| turn.tag_id)
    }

    pub(crate) fn shown(&self, task_id: &str) -> Option<Shown> {
        let turns = self.turns.lock().unwrap();
        let turn = turns.get(task_id).filter(|turn| !turn.text.is_empty())?;
        Some(Shown {
            version: turn.version,
            after_sequence: turn.after_sequence,
            text: turn.text.clone(),
        })
    }
}

impl Store {
    /// Records the text of the message a running Attempt's Tag is writing, for the follows of its
    /// conversation. It is never stored.
    pub async fn publish_text(
        &self,
        authority: &crate::AttemptAccess,
        input: &PublishTaskTextRequest,
    ) -> Result<()> {
        let attempt = authority.lease();
        let task = self
            .inspect_attempt(
                authority.host(),
                &attempt.task_id,
                &attempt.attempt_id,
                &attempt.lease_token,
            )
            .await?;
        if task.state() != TaskState::Running {
            return Err(StoreError::FailedPrecondition(
                "the Task Attempt is not running".into(),
            ));
        }
        if self.live.texts.set(&task.tag_id, &attempt.task_id, input) {
            self.live.bus.text(&task.tag_id);
        }
        Ok(())
    }

    /// A message event was recorded for the turn after commit.
    pub(crate) fn text_recorded(&self, task_id: &str, sequence: u64) {
        if let Some(tag_id) = self.live.texts.recorded(task_id, sequence) {
            self.live.bus.text(&tag_id);
        }
    }

    /// The turn finished after commit.
    pub(crate) fn text_finished(&self, task_id: &str) {
        if let Some(tag_id) = self.live.texts.forget(task_id) {
            self.live.bus.text(&tag_id);
        }
    }
}
