//! The digest of a Team channel's unread messages that an inbox turn starts with.
use sqlx::{Any, Transaction};

use crate::store::Result;

/// Unread channel messages, summarized within a budget.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Digest {
    /// Empty when there is nothing to show.
    pub text: String,
    /// The last seq the digest covers; the member's delivery position moves to it.
    pub through_seq: Option<i64>,
    /// Unread messages left out for the budget.
    pub more: u64,
}

/// The digest of the channel's messages from `from_seq` on, for `tag_id`, in at most
/// `budget_bytes`. Until channel digests are built, it is empty.
pub(crate) async fn channel_digest_in(
    _tx: &mut Transaction<'_, Any>,
    _tag_id: &str,
    _conversation_id: &str,
    _from_seq: i64,
    _budget_bytes: usize,
) -> Result<Digest> {
    Ok(Digest::default())
}
