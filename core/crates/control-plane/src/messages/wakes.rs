//! Wake rows: which Tag must take an inbox turn for which messages. A pending wake (no Task yet)
//! is coalesced per Tag and conversation, so a burst of messages makes one turn; the inbox Task
//! that delivers it binds the wake and records the seqs it delivered.
use sqlx::{Any, Transaction};
use supertag_protocol::v2::MessageKind;
use uuid::Uuid;

use super::ConversationKind;
use crate::{StoreError, store::Result};

/// A message continues a chain through at most this many inboxes.
pub(crate) const MAX_HOPS: i64 = 4;

/// `supertag_v2_wakes.reasons` bits.
pub(crate) const REASON_DIRECT: i64 = 1;
pub(crate) const REASON_ADDRESSED: i64 = 2;
pub(crate) const REASON_QUESTION: i64 = 4;
pub(crate) const REASON_BLOCKER: i64 = 8;
pub(crate) const REASON_REVIEW: i64 = 16;

pub(crate) struct WakeRequest<'a> {
    /// The Tag to wake.
    pub tag_id: &'a str,
    pub conversation_id: &'a str,
    pub kind: ConversationKind,
    pub message_kind: MessageKind,
    /// The message names the Tag (a post's `to`).
    pub addressed: bool,
    pub sender_tag_id: &'a str,
    pub seq: i64,
    pub hops: i64,
    pub origin_task_id: Option<&'a str>,
    pub objective_id: Option<&'a str>,
    /// The Team whose wake limits apply, if any.
    pub team_id: Option<&'a str>,
    pub now: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WakeOutcome {
    /// A wake row was written or coalesced.
    pub woke: bool,
    /// Why the recipient was not woken now; the sender is told.
    pub deferred: Option<String>,
}

/// The reason bits and priority of a wake for one message.
pub(crate) fn reasons_and_priority(request: &WakeRequest<'_>) -> (i64, i64) {
    let mut reasons = 0;
    if request.kind == ConversationKind::Direct {
        reasons |= REASON_DIRECT;
    }
    if request.addressed {
        reasons |= REASON_ADDRESSED;
    }
    let (bit, priority) = match request.message_kind {
        MessageKind::Question => (REASON_QUESTION, 2),
        MessageKind::Blocker => (REASON_BLOCKER, 3),
        MessageKind::Review => (REASON_REVIEW, 2),
        _ => (0, 1),
    };
    // A wake always has a reason; an unaddressed channel message wakes as addressed.
    reasons |= bit;
    if reasons == 0 {
        reasons = REASON_ADDRESSED;
    }
    (reasons, priority)
}

/// Writes or coalesces the Tag's pending wake for the conversation, due now. The coalesced wake
/// keeps its first seq and origin, and takes the highest priority and hops, the latest seq, and
/// the earliest due time.
pub(crate) async fn wake_in(
    tx: &mut Transaction<'_, Any>,
    request: &WakeRequest<'_>,
) -> Result<WakeOutcome> {
    let (reasons, priority) = reasons_and_priority(request);
    sqlx::query(
        "INSERT INTO supertag_v2_wakes
            (wake_id,tag_id,conversation_id,reasons,priority,first_seq,last_seq,hops,
             origin_task_id,objective_id,not_before_ms,created_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$10)
         ON CONFLICT(tag_id,conversation_id) WHERE task_id IS NULL DO UPDATE SET
            reasons=supertag_v2_wakes.reasons | excluded.reasons,
            priority=CASE WHEN excluded.priority>supertag_v2_wakes.priority
                THEN excluded.priority ELSE supertag_v2_wakes.priority END,
            last_seq=CASE WHEN excluded.last_seq>supertag_v2_wakes.last_seq
                THEN excluded.last_seq ELSE supertag_v2_wakes.last_seq END,
            hops=CASE WHEN excluded.hops>supertag_v2_wakes.hops
                THEN excluded.hops ELSE supertag_v2_wakes.hops END,
            not_before_ms=CASE WHEN excluded.not_before_ms<supertag_v2_wakes.not_before_ms
                THEN excluded.not_before_ms ELSE supertag_v2_wakes.not_before_ms END",
    )
    .bind(Uuid::new_v4().simple().to_string())
    .bind(request.tag_id)
    .bind(request.conversation_id)
    .bind(reasons)
    .bind(priority)
    .bind(request.seq)
    .bind(request.hops)
    .bind(request.origin_task_id)
    .bind(request.objective_id)
    .bind(request.now)
    .execute(&mut **tx)
    .await?;
    Ok(WakeOutcome {
        woke: true,
        deferred: None,
    })
}

/// The hops and originating Task of a message the Task sends. An inbox turn, or an approval
/// continuation of one, continues the chain of the deepest wake delivered to it; any other Task
/// starts a chain of its own.
pub(crate) async fn origin_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<(i64, String)> {
    // An approval continuation has no delivered wakes of its own: follow the decisions back to the
    // Task that asked.
    let deepest: Option<(i64, Option<String>)> = sqlx::query_as(
        "WITH RECURSIVE source_tasks(task_id) AS (
            SELECT CAST($1 AS TEXT)
            UNION
            SELECT w.task_id FROM supertag_v2_approval_waits w
            JOIN source_tasks s ON w.continuation_task_id=s.task_id
        ) SELECT w.hops,w.origin_task_id FROM supertag_v2_wakes w
          JOIN source_tasks s ON w.task_id=s.task_id
          ORDER BY w.hops DESC,w.created_at_ms,w.wake_id LIMIT 1",
    )
    .bind(task_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((hops, origin)) = deepest else {
        return Ok((0, task_id.to_owned()));
    };
    let hops = hops + 1;
    if hops > MAX_HOPS {
        return Err(StoreError::FailedPrecondition(
            "this message would continue a chain through more than four inboxes".into(),
        ));
    }
    Ok((hops, origin.unwrap_or_else(|| task_id.to_owned())))
}

/// Tags with a wake due now, most urgent first. A retired Tag takes no turns.
pub(crate) async fn due_recipients_in(
    tx: &mut Transaction<'_, Any>,
    now: i64,
    limit: i64,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT w.tag_id FROM supertag_v2_wakes w
         JOIN supertag_v2_tags tag ON tag.tag_id=w.tag_id
         WHERE w.task_id IS NULL AND w.not_before_ms<=$1 AND tag.retired_at_ms IS NULL
         GROUP BY w.tag_id
         ORDER BY MAX(w.priority) DESC,MIN(w.not_before_ms),MIN(w.created_at_ms),w.tag_id
         LIMIT $2",
    )
    .bind(now)
    .bind(limit)
    .fetch_all(&mut **tx)
    .await?)
}
