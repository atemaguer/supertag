//! Wakes: which Tag must take an inbox turn for which messages. A wake is a Tag message input
//! of the Tag's inbox Session (`crate::session_inputs`, kind 4), and the input queue is the only
//! record of a Tag message its recipient has not been given. A pending row (no Task yet) is
//! coalesced per Tag and conversation, so a burst of messages makes one turn; the inbox Task that
//! delivers it binds the row and records the seqs it delivered. A row with a due time wakes the
//! Tag; a held row (no due time) wakes nobody and is bound by the Tag's next inbox turn. An inbox
//! turn binds the rows of several sending Tags at once: the inbox exception to "a run binds only
//! inputs that share its requester and reply audience", under the receiving Tag's own policy
//! (`crate::mailbox`). Only direct messages make rows: a Workstream post wakes nobody and reaches
//! its members in the digest of their next turn.
//!
//! Only Tags' messages come through here, so only they count toward the wake limits: mutual wakes
//! per pair of Tags per originating Task, and Tag-originated wakes per woken Tag and per Objective
//! per hour. A wake counts only when it would start an activation, meaning the Tag has no pending
//! wake already; coalesced wakes are free, and held rows count toward neither the limits nor the
//! backlog. Over a limit, or past the backlog, a note, evidence, or decision is held for the Tag's
//! next turn; a question, blocker, or review request gets a deferred wake, and pulls a held row
//! of its conversation forward. A wake the pair limit deferred while its originating Task still
//! runs is released when that Task ends, and after an hour at the latest. Nothing is dropped, the
//! sender is told why, and the operator gets one Inbox item per limit and window.
use sqlx::{Any, Transaction};
use supertag_protocol::v2::{MessageKind, TaskState};
use uuid::Uuid;

use crate::{StoreError, store::Result};

/// A message continues a chain through at most this many inboxes.
pub(crate) const MAX_HOPS: i64 = 4;

/// `supertag_v2_session_inputs.reasons` bits of a wake. Bit 2 was an addressed Workstream post's; posts no longer
/// wake.
pub(crate) const REASON_DIRECT: i64 = 1;
pub(crate) const REASON_QUESTION: i64 = 4;
pub(crate) const REASON_BLOCKER: i64 = 8;
pub(crate) const REASON_REVIEW: i64 = 16;

/// A burst of notes and questions within this window lands in one turn. Blockers and review
/// requests are due at once.
pub(crate) const DEBOUNCE_MS: i64 = 3_000;
/// A Tag with this many pending wakes gets no new wake for a note, evidence, or decision.
pub(crate) const BACKLOG: i64 = 64;
/// Wake-limit windows are fixed hours.
pub(crate) const HOUR_MS: i64 = 3_600_000;

/// The defaults a Team's `spec.wakeLimits` overrides.
pub(crate) const DEFAULT_MUTUAL_PER_TASK: i64 = 3;
pub(crate) const DEFAULT_PER_TAG_PER_HOUR: i64 = 20;
pub(crate) const DEFAULT_PER_OBJECTIVE_PER_HOUR: i64 = 60;

/// `supertag_v2_wake_limit_trips.scope` (and `supertag_v2_wake_counts.scope` for 1 and 2).
pub(crate) const LIMIT_TAG: i64 = 1;
pub(crate) const LIMIT_OBJECTIVE: i64 = 2;
pub(crate) const LIMIT_PAIR: i64 = 3;

pub(crate) struct WakeRequest<'a> {
    /// The Tag to wake.
    pub tag_id: &'a str,
    /// The direct conversation the message is in.
    pub conversation_id: &'a str,
    pub message_kind: MessageKind,
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
    /// The message's row is due, now or deferred: the Tag takes a turn for it. False when a wake
    /// limit or the backlog held it for the Tag's next turn.
    pub woke: bool,
    /// Why the recipient was not woken now; the sender is told.
    pub deferred: Option<String>,
}

/// The reason bits and priority of a wake for one message.
pub(crate) fn reasons_and_priority(request: &WakeRequest<'_>) -> (i64, i64) {
    let (bit, priority) = match request.message_kind {
        MessageKind::Question => (REASON_QUESTION, 2),
        MessageKind::Blocker => (REASON_BLOCKER, 3),
        MessageKind::Review => (REASON_REVIEW, 2),
        _ => (0, 1),
    };
    (REASON_DIRECT | bit, priority)
}

/// The word a sender's notice uses for the message.
fn kind_word(kind: MessageKind) -> &'static str {
    match kind {
        MessageKind::Question => "question",
        MessageKind::Blocker => "blocker",
        MessageKind::Review => "review request",
        MessageKind::Evidence => "evidence",
        MessageKind::Decision => "decision",
        MessageKind::Unspecified | MessageKind::Note => "note",
    }
}

/// The wake limits that apply to a Team's messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Limits {
    pub mutual_per_task: i64,
    pub per_tag_per_hour: i64,
    pub per_objective_per_hour: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            mutual_per_task: DEFAULT_MUTUAL_PER_TASK,
            per_tag_per_hour: DEFAULT_PER_TAG_PER_HOUR,
            per_objective_per_hour: DEFAULT_PER_OBJECTIVE_PER_HOUR,
        }
    }
}

/// The Team's overrides over the defaults; a deleted or missing Team keeps the defaults.
pub(crate) async fn limits_in(
    tx: &mut Transaction<'_, Any>,
    team_id: Option<&str>,
) -> Result<Limits> {
    let mut limits = Limits::default();
    let Some(team_id) = team_id else {
        return Ok(limits);
    };
    let row: Option<(Option<i64>, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT wake_mutual_limit,wake_tag_hourly_limit,wake_objective_hourly_limit
         FROM supertag_v2_teams WHERE team_id=$1",
    )
    .bind(team_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some((mutual, tag, objective)) = row {
        limits.mutual_per_task = mutual.unwrap_or(limits.mutual_per_task);
        limits.per_tag_per_hour = tag.unwrap_or(limits.per_tag_per_hour);
        limits.per_objective_per_hour = objective.unwrap_or(limits.per_objective_per_hour);
    }
    Ok(limits)
}

/// A limit the wake would pass.
struct Trip {
    scope: i64,
    scope_id: String,
    window_start_ms: i64,
    limit: i64,
    /// When a deferred wake comes due at the latest.
    until_ms: i64,
    /// The running Task whose end releases a deferred wake sooner.
    release_task_id: Option<String>,
    /// Why the wake waits, without what happens next.
    reason: String,
}

fn times(count: i64) -> String {
    if count == 1 {
        "once".to_owned()
    } else {
        format!("{count} times")
    }
}

fn window_start(now: i64) -> i64 {
    now - now.rem_euclid(HOUR_MS)
}

fn pair<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a <= b { (a, b) } else { (b, a) }
}

async fn counted_in(
    tx: &mut Transaction<'_, Any>,
    scope: i64,
    scope_id: &str,
    window: i64,
) -> Result<i64> {
    let wakes: Option<i64> = sqlx::query_scalar(
        "SELECT wakes FROM supertag_v2_wake_counts
         WHERE scope=$1 AND scope_id=$2 AND window_start_ms=$3",
    )
    .bind(scope)
    .bind(scope_id)
    .bind(window)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(wakes.unwrap_or(0))
}

/// The first limit this wake would pass: the pair's, then the woken Tag's, then the Objective's.
async fn trip_in(
    tx: &mut Transaction<'_, Any>,
    request: &WakeRequest<'_>,
    limits: Limits,
) -> Result<Option<Trip>> {
    let now = request.now;
    if let Some(origin) = request.origin_task_id
        && request.sender_tag_id != request.tag_id
    {
        let (a, b) = pair(request.sender_tag_id, request.tag_id);
        let wakes: Option<i64> = sqlx::query_scalar(
            "SELECT wakes FROM supertag_v2_wake_pairs
             WHERE origin_task_id=$1 AND tag_a=$2 AND tag_b=$3",
        )
        .bind(origin)
        .bind(a)
        .bind(b)
        .fetch_optional(&mut **tx)
        .await?;
        if wakes.unwrap_or(0) >= limits.mutual_per_task {
            // The limit is per originating Task: once that Task ends, its exchange is over.
            let state: Option<i64> =
                sqlx::query_scalar("SELECT state FROM supertag_v2_tasks WHERE task_id=$1")
                    .bind(origin)
                    .fetch_optional(&mut **tx)
                    .await?;
            let running = state.is_some_and(|state| !ENDED.contains(&state));
            return Ok(Some(Trip {
                scope: LIMIT_PAIR,
                scope_id: format!("{origin}\n{a}\n{b}"),
                window_start_ms: 0,
                limit: limits.mutual_per_task,
                until_ms: now + HOUR_MS,
                release_task_id: running.then(|| origin.to_owned()),
                reason: format!(
                    "{a} and {b} already woke each other {} for Task {origin}",
                    times(limits.mutual_per_task)
                ),
            }));
        }
    }
    let window = window_start(now);
    if counted_in(tx, LIMIT_TAG, request.tag_id, window).await? >= limits.per_tag_per_hour {
        return Ok(Some(Trip {
            scope: LIMIT_TAG,
            scope_id: request.tag_id.to_owned(),
            window_start_ms: window,
            limit: limits.per_tag_per_hour,
            until_ms: window + HOUR_MS,
            release_task_id: None,
            reason: format!(
                "Tag {} was already woken {} this hour by other Tags",
                request.tag_id,
                times(limits.per_tag_per_hour)
            ),
        }));
    }
    if let Some(objective) = request.objective_id
        && counted_in(tx, LIMIT_OBJECTIVE, objective, window).await?
            >= limits.per_objective_per_hour
    {
        return Ok(Some(Trip {
            scope: LIMIT_OBJECTIVE,
            scope_id: objective.to_owned(),
            window_start_ms: window,
            limit: limits.per_objective_per_hour,
            until_ms: window + HOUR_MS,
            release_task_id: None,
            reason: format!(
                "Objective {objective} already woke its Tags {} this hour",
                times(limits.per_objective_per_hour)
            ),
        }));
    }
    Ok(None)
}

/// Counts a wake that starts an activation against every limit it is under.
async fn count_in(tx: &mut Transaction<'_, Any>, request: &WakeRequest<'_>) -> Result<()> {
    if let Some(origin) = request.origin_task_id
        && request.sender_tag_id != request.tag_id
    {
        let (a, b) = pair(request.sender_tag_id, request.tag_id);
        sqlx::query(
            "INSERT INTO supertag_v2_wake_pairs (origin_task_id,tag_a,tag_b,wakes)
             VALUES ($1,$2,$3,1) ON CONFLICT(origin_task_id,tag_a,tag_b)
             DO UPDATE SET wakes=supertag_v2_wake_pairs.wakes+1",
        )
        .bind(origin)
        .bind(a)
        .bind(b)
        .execute(&mut **tx)
        .await?;
    }
    let window = window_start(request.now);
    let mut scopes = vec![(LIMIT_TAG, request.tag_id)];
    if let Some(objective) = request.objective_id {
        scopes.push((LIMIT_OBJECTIVE, objective));
    }
    for (scope, id) in scopes {
        sqlx::query(
            "INSERT INTO supertag_v2_wake_counts (scope,scope_id,window_start_ms,wakes)
             VALUES ($1,$2,$3,1) ON CONFLICT(scope,scope_id,window_start_ms)
             DO UPDATE SET wakes=supertag_v2_wake_counts.wakes+1",
        )
        .bind(scope)
        .bind(id)
        .bind(window)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// One operator Inbox item per tripped limit and window; each message it holds is counted.
async fn record_trip_in(
    tx: &mut Transaction<'_, Any>,
    request: &WakeRequest<'_>,
    trip: &Trip,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO supertag_v2_wake_limit_trips
            (scope,scope_id,window_start_ms,team_id,objective_id,sender_tag_id,recipient_tag_id,
             wake_limit,held,tripped_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9)
         ON CONFLICT(scope,scope_id,window_start_ms)
         DO UPDATE SET held=supertag_v2_wake_limit_trips.held+1",
    )
    .bind(trip.scope)
    .bind(&trip.scope_id)
    .bind(trip.window_start_ms)
    .bind(request.team_id)
    .bind(request.objective_id)
    .bind(request.sender_tag_id)
    .bind(request.tag_id)
    .bind(trip.limit)
    .bind(request.now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Wakes the Tag for a Tag's message, within the wake limits, and says why when it waits.
///
/// The Tag's pending row for the conversation is written or coalesced: it keeps its first seq
/// and origin, and takes the highest priority and hops, the latest seq, and the earliest due time.
/// A note or question is due after [`DEBOUNCE_MS`], so a burst lands in one turn; a blocker or
/// review request is due now and pulls an existing wake forward. A note, evidence, or decision
/// over a wake limit or the backlog is written as a held row instead (`woke: false`), which the
/// Tag's next inbox turn binds.
pub(crate) async fn wake_in(
    tx: &mut Transaction<'_, Any>,
    request: &WakeRequest<'_>,
) -> Result<WakeOutcome> {
    let (reasons, priority) = reasons_and_priority(request);
    let urgent = matches!(
        request.message_kind,
        MessageKind::Blocker | MessageKind::Review
    );
    let (pending, active, same): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*),
                COUNT(CASE WHEN deferred_reason IS NULL THEN 1 END),
                COUNT(CASE WHEN conversation_id=$2 THEN 1 END)
         FROM supertag_v2_session_inputs
         WHERE tag_id=$1 AND task_id IS NULL AND conversation_id IS NOT NULL
           AND not_before_ms IS NOT NULL",
    )
    .bind(request.tag_id)
    .bind(request.conversation_id)
    .fetch_one(&mut **tx)
    .await?;
    // `None` holds the message: it waits for the Tag's next inbox turn and wakes nobody.
    let mut not_before = Some(if urgent {
        request.now
    } else {
        request.now + DEBOUNCE_MS
    });
    let mut deferred_reason = None;
    let mut release_task_id = None;
    let mut notice = None;
    if priority == 1 && same == 0 && pending >= BACKLOG {
        not_before = None;
        notice = Some(format!(
            "Tag {} is behind; it sees this in its next turn.",
            request.tag_id
        ));
    } else if active == 0 {
        // A Tag with a pending wake takes a turn anyway: this wake starts nothing and is free.
        let limits = limits_in(tx, request.team_id).await?;
        match trip_in(tx, request, limits).await? {
            Some(trip) => {
                record_trip_in(tx, request, &trip).await?;
                let tag = request.tag_id;
                if priority == 1 {
                    not_before = None;
                    notice = Some(format!(
                        "{}; Tag {tag} will see this message in its next turn.",
                        trip.reason
                    ));
                } else {
                    let when = match &trip.release_task_id {
                        Some(task) => format!("when Task {task} ends"),
                        None => "when the limit resets".to_owned(),
                    };
                    notice = Some(format!(
                        "{}; Tag {tag} gets this {} {when}, within the hour.",
                        trip.reason,
                        kind_word(request.message_kind)
                    ));
                    not_before = Some(trip.until_ms);
                    deferred_reason = Some(trip.reason);
                    release_task_id = trip.release_task_id;
                }
            }
            None => count_in(tx, request).await?,
        }
    }
    let position = crate::store::increment_order(tx).await?;
    let wake_id = Uuid::new_v4().simple().to_string();
    // A due time wins over held (none), and the earlier due time over a later one; the reason it
    // waits and the Task that releases it follow the winning due time. A held message coalesced
    // into a pending wake is delivered with it.
    sqlx::query(
        "INSERT INTO supertag_v2_session_inputs
            (input_id,tag_id,session_id,position,kind,source_key,requester,audience,
             conversation_id,reasons,priority,first_seq,last_seq,hops,
             origin_task_id,objective_id,not_before_ms,deferred_reason,release_task_id,
             created_at_ms)
         VALUES ($1,$2,$3,$4,4,$5,$6,'',$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT(tag_id,conversation_id) WHERE task_id IS NULL AND conversation_id IS NOT NULL
         DO UPDATE SET
            reasons=supertag_v2_session_inputs.reasons | excluded.reasons,
            priority=CASE WHEN excluded.priority>supertag_v2_session_inputs.priority
                THEN excluded.priority ELSE supertag_v2_session_inputs.priority END,
            last_seq=CASE WHEN excluded.last_seq>supertag_v2_session_inputs.last_seq
                THEN excluded.last_seq ELSE supertag_v2_session_inputs.last_seq END,
            hops=CASE WHEN excluded.hops>supertag_v2_session_inputs.hops
                THEN excluded.hops ELSE supertag_v2_session_inputs.hops END,
            deferred_reason=CASE WHEN excluded.not_before_ms IS NOT NULL
                AND (supertag_v2_session_inputs.not_before_ms IS NULL
                  OR excluded.not_before_ms<supertag_v2_session_inputs.not_before_ms)
                THEN excluded.deferred_reason ELSE supertag_v2_session_inputs.deferred_reason END,
            release_task_id=CASE WHEN excluded.not_before_ms IS NOT NULL
                AND (supertag_v2_session_inputs.not_before_ms IS NULL
                  OR excluded.not_before_ms<supertag_v2_session_inputs.not_before_ms)
                THEN excluded.release_task_id ELSE supertag_v2_session_inputs.release_task_id END,
            not_before_ms=CASE WHEN excluded.not_before_ms IS NOT NULL
                AND (supertag_v2_session_inputs.not_before_ms IS NULL
                  OR excluded.not_before_ms<supertag_v2_session_inputs.not_before_ms)
                THEN excluded.not_before_ms ELSE supertag_v2_session_inputs.not_before_ms END",
    )
    .bind(&wake_id)
    .bind(request.tag_id)
    .bind(format!("inbox:{}", request.tag_id))
    .bind(position)
    .bind(format!("wake\n{wake_id}"))
    .bind(format!("tag:{}", request.sender_tag_id))
    .bind(request.conversation_id)
    .bind(reasons)
    .bind(priority)
    .bind(request.seq)
    .bind(request.hops)
    .bind(request.origin_task_id)
    .bind(request.objective_id)
    .bind(not_before)
    .bind(deferred_reason)
    .bind(release_task_id)
    .bind(request.now)
    .execute(&mut **tx)
    .await?;
    Ok(WakeOutcome {
        woke: not_before.is_some(),
        deferred: notice,
    })
}

/// The states in which a Task has ended.
const ENDED: [i64; 3] = [
    TaskState::Succeeded as i64,
    TaskState::Failed as i64,
    TaskState::Cancelled as i64,
];

/// Releases the wakes the pair limit deferred until `task_id` ends: they are due now, and keep
/// the reason they waited. Returns how many it released. Called in the transaction that ends the
/// Task.
pub(crate) async fn release_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    now: i64,
) -> Result<u64> {
    Ok(sqlx::query(
        "UPDATE supertag_v2_session_inputs SET release_task_id=NULL,
            not_before_ms=CASE WHEN not_before_ms>$1 THEN $1 ELSE not_before_ms END
         WHERE task_id IS NULL AND release_task_id=$2",
    )
    .bind(now)
    .bind(task_id)
    .execute(&mut **tx)
    .await?
    .rows_affected())
}

/// Releases the deferred wakes of every originating Task that has ended, for a Task that ended
/// without passing through [`release_in`], such as one its Objective cancelled.
pub(crate) async fn release_ended_in(tx: &mut Transaction<'_, Any>, now: i64) -> Result<()> {
    sqlx::query(
        "UPDATE supertag_v2_session_inputs SET release_task_id=NULL,
            not_before_ms=CASE WHEN not_before_ms>$1 THEN $1 ELSE not_before_ms END
         WHERE task_id IS NULL AND release_task_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM supertag_v2_tasks t
            WHERE t.task_id=supertag_v2_session_inputs.release_task_id AND t.state IN ($2,$3,$4))",
    )
    .bind(now)
    .bind(ENDED[0])
    .bind(ENDED[1])
    .bind(ENDED[2])
    .execute(&mut **tx)
    .await?;
    Ok(())
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
        ) SELECT w.hops,w.origin_task_id FROM supertag_v2_session_inputs w
          JOIN source_tasks s ON w.task_id=s.task_id
          WHERE w.conversation_id IS NOT NULL
          ORDER BY w.hops DESC,w.created_at_ms,w.position LIMIT 1",
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

/// Tags with a wake due now that may take a new inbox turn, most urgent first. A held message is
/// never due. A retired Tag takes no turns; a Tag whose inbox turn waits or is claimed (a Queued
/// or Claimed Task that reserved Tag messages) gets no second one; a Tag whose
/// Workspace changed since its last inbox turn keeps its mail pending. Only Workspace changes are
/// filtered here; `insert_task` checks the rest of the accepted policy.
pub(crate) async fn due_recipients_in(
    tx: &mut Transaction<'_, Any>,
    now: i64,
    limit: i64,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT w.tag_id FROM supertag_v2_session_inputs w
         JOIN supertag_v2_tags tag ON tag.tag_id=w.tag_id
         WHERE w.task_id IS NULL AND w.conversation_id IS NOT NULL AND w.not_before_ms<=$1
           AND tag.retired_at_ms IS NULL
           AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks t
             WHERE t.tag_id=w.tag_id AND t.session_id=w.session_id AND t.state IN ($3,$4)
             AND EXISTS (SELECT 1 FROM supertag_v2_session_inputs r
               WHERE r.admitted_task_id=t.task_id AND r.conversation_id IS NOT NULL))
           AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks previous
             WHERE previous.tag_id=w.tag_id
             AND previous.session_id=('inbox:' || w.tag_id)
             AND (COALESCE(previous.workspace_id,'')<>COALESCE(tag.workspace_id,'')
               OR COALESCE(previous.workspace_base_ref,'')<>COALESCE(tag.workspace_base_ref,'')
               OR (tag.workspace_base_ref IS NULL
                 AND COALESCE(previous.workspace_base_commit,'')<>COALESCE(tag.workspace_base_commit,''))))
         GROUP BY w.tag_id
         ORDER BY MAX(w.priority) DESC,MIN(w.not_before_ms),MIN(w.created_at_ms),w.tag_id
         LIMIT $2",
    )
    .bind(now)
    .bind(limit)
    .bind(supertag_protocol::v2::TaskState::Queued as i64)
    .bind(supertag_protocol::v2::TaskState::Claimed as i64)
    .fetch_all(&mut **tx)
    .await?)
}
