//! A Session's input queue: every input to a Session is one row of
//! `supertag_v2_session_inputs`, ordered per Session by `position` (taken from the global write
//! order), with an idempotency key from its source and a kind. A Task, one run of the Session,
//! binds pending inputs when it is admitted, claimed, or started:
//!
//! - its own input, the one it was admitted for, at its claim ([`bind_own_in`]);
//! - a person's later messages that join its first claim, or that its running Attempt accepted
//!   (`crate::inputs`);
//! - for an inbox turn, the Tag's due and held Tag messages at its start (`crate::mailbox`). This
//!   is the inbox exception: an inbox turn binds messages from several Tags, under the receiving
//!   Tag's own policy. Every other run binds only inputs that share its requester and reply
//!   audience ([`shares_with`]).
//!
//! An input is handled when the run that bound it ends. A redelivered Task keeps its ID, so what
//! it bound stays bound; the messages its lost Attempt was offered are settled by
//! [`redeliver_in`] and presented to the next Attempt by [`replayed_in`].
//!
//! "Input" is an internal word: Task, Task Attempt, Session, Mailbox, and Workstream keep their
//! names in the product.
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{JoinedMessage, LiveInputState, Task, TaskState};
use uuid::Uuid;

use crate::{StoreError, store::Result};

/// What an input is. Stored as its number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i64)]
pub(crate) enum InputKind {
    /// A SubmitTask request, or an Objective's home Task.
    Request = 1,
    /// A person's message: in a conversation, in a chat thread, or as live input.
    Person = 2,
    /// A GitHub, Linear, or other surface event.
    SurfaceEvent = 3,
    /// Another Tag's direct message, for the recipient's inbox Session.
    TagMessage = 4,
    ScheduleFire = 5,
    /// A work Session's report to its parent.
    Report = 6,
    /// An approval decision, a question's answer, or Objective review feedback.
    Decision = 7,
    /// An Objective budget, deadline, idle, or resume notice; an approval budget stop.
    Notice = 8,
}

impl InputKind {
    pub(crate) fn from_stored(stored: i64) -> Result<Self> {
        Ok(match stored {
            1 => Self::Request,
            2 => Self::Person,
            3 => Self::SurfaceEvent,
            4 => Self::TagMessage,
            5 => Self::ScheduleFire,
            6 => Self::Report,
            7 => Self::Decision,
            8 => Self::Notice,
            _ => {
                return Err(StoreError::FailedPrecondition(
                    "unknown Session input kind".into(),
                ));
            }
        })
    }
}

/// An input a source admits with its Task.
pub(crate) struct NewInput<'a> {
    pub kind: InputKind,
    /// The source's idempotency key, from [`key`].
    pub source_key: String,
    /// Who the input acts for.
    pub requester: &'a str,
    /// Who sees the reply: the Task audience owner, empty for none.
    pub audience: &'a str,
}

/// One input as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InputRow {
    pub input_id: String,
    pub tag_id: String,
    pub session_id: String,
    pub position: i64,
    pub kind: InputKind,
    pub source_key: String,
    pub requester: String,
    pub audience: String,
    pub admitted_task_id: Option<String>,
    pub task_id: Option<String>,
    pub bound_at_claim: bool,
    pub offer_task_id: Option<String>,
    pub offer_attempt_id: Option<String>,
    pub offer_state: Option<i64>,
}

pub(crate) fn input_row(row: &AnyRow) -> Result<InputRow> {
    Ok(InputRow {
        input_id: row.try_get("input_id")?,
        tag_id: row.try_get("tag_id")?,
        session_id: row.try_get("session_id")?,
        position: row.try_get("position")?,
        kind: InputKind::from_stored(row.try_get("kind")?)?,
        source_key: row.try_get("source_key")?,
        requester: row.try_get("requester")?,
        audience: row.try_get("audience")?,
        admitted_task_id: row.try_get("admitted_task_id")?,
        task_id: row.try_get("task_id")?,
        bound_at_claim: row.try_get::<i64, _>("bound_at_claim")? == 1,
        offer_task_id: row.try_get("offer_task_id")?,
        offer_attempt_id: row.try_get("offer_attempt_id")?,
        offer_state: row.try_get("offer_state")?,
    })
}

/// A source key: its fields joined by a newline. Names and IDs hold no control characters.
pub(crate) fn key(parts: &[&str]) -> String {
    parts.join("\n")
}

/// Records `input` for the just-admitted `task`, pending until a run binds it. Its position is
/// the Task's own place in the write order. A second input for the same source fails.
pub(crate) async fn admit_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: NewInput<'_>,
    now: i64,
) -> Result<InputRow> {
    insert_in(tx, task, input, false, now).await
}

/// [`admit_in`] for a Task settled at admission, such as a `/goal` command the Control Plane
/// answers itself: the input is bound to it at once.
// The sources that admit person messages and settled answers call it (stage 2 slices b-d).
#[allow(dead_code)]
pub(crate) async fn admit_bound_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: NewInput<'_>,
    now: i64,
) -> Result<InputRow> {
    insert_in(tx, task, input, true, now).await
}

async fn insert_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: NewInput<'_>,
    bound: bool,
    now: i64,
) -> Result<InputRow> {
    if input.kind == InputKind::TagMessage {
        return Err(StoreError::FailedPrecondition(
            "Tag messages are queued through their wake".into(),
        ));
    }
    if let Some(prior) = by_key_in(tx, &input.source_key).await? {
        if prior.admitted_task_id.as_deref() != Some(task.task_id.as_str()) {
            return Err(StoreError::Conflict(
                "Session input source was already admitted".into(),
            ));
        }
        return Ok(prior);
    }
    let position: i64 =
        sqlx::query_scalar("SELECT accepted_order FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(&task.task_id)
            .fetch_one(&mut **tx)
            .await?;
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO supertag_v2_session_inputs
            (input_id,tag_id,session_id,position,kind,source_key,requester,audience,
             admitted_task_id,task_id,bound_at_ms,created_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    )
    .bind(&id)
    .bind(&task.tag_id)
    .bind(&task.session_id)
    .bind(position)
    .bind(input.kind as i64)
    .bind(&input.source_key)
    .bind(input.requester)
    .bind(input.audience)
    .bind(&task.task_id)
    .bind(bound.then_some(task.task_id.as_str()))
    .bind(bound.then_some(now))
    .bind(now)
    .execute(&mut **tx)
    .await?;
    by_id_in(tx, &id)
        .await?
        .ok_or_else(|| StoreError::FailedPrecondition("Session input was not recorded".into()))
}

pub(crate) async fn by_id_in(
    tx: &mut Transaction<'_, Any>,
    input_id: &str,
) -> Result<Option<InputRow>> {
    sqlx::query("SELECT * FROM supertag_v2_session_inputs WHERE input_id=$1")
        .bind(input_id)
        .fetch_optional(&mut **tx)
        .await?
        .as_ref()
        .map(input_row)
        .transpose()
}

/// The input a source key admitted, if any.
pub(crate) async fn by_key_in(
    tx: &mut Transaction<'_, Any>,
    key: &str,
) -> Result<Option<InputRow>> {
    sqlx::query("SELECT * FROM supertag_v2_session_inputs WHERE source_key=$1")
        .bind(key)
        .fetch_optional(&mut **tx)
        .await?
        .as_ref()
        .map(input_row)
        .transpose()
}

/// The input `task_id` was admitted for, if it has one. An inbox Task's reserved Tag messages are
/// not its own.
pub(crate) async fn own_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<Option<InputRow>> {
    sqlx::query(
        "SELECT * FROM supertag_v2_session_inputs
         WHERE admitted_task_id=$1 AND conversation_id IS NULL",
    )
    .bind(task_id)
    .fetch_optional(&mut **tx)
    .await?
    .as_ref()
    .map(input_row)
    .transpose()
}

/// Who `task_id` acts for and who sees its reply: its own input's requester and audience. A Task
/// with no input acts for its audience owner. One that has none either, a chat thread's Task,
/// acts for the connector account that admitted it.
pub(crate) async fn requester_of_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<(String, String)> {
    if let Some(own) = own_in(tx, task_id).await? {
        return Ok((own.requester, own.audience));
    }
    let owner: String =
        sqlx::query_scalar("SELECT owner FROM supertag_v2_task_audience WHERE task_id=$1")
            .bind(task_id)
            .fetch_optional(&mut **tx)
            .await?
            .unwrap_or_default();
    if !owner.is_empty() {
        return Ok((owner.clone(), owner));
    }
    let account: Option<String> = sqlx::query_scalar(
        "SELECT account_id FROM supertag_v2_inbound_events WHERE task_id=$1
         UNION ALL SELECT account_id FROM supertag_v2_slack_messages WHERE task_id=$1
         UNION ALL SELECT account_id FROM supertag_v2_lark_messages WHERE task_id=$1
         UNION ALL SELECT account_id FROM supertag_v2_microsoft_teams_activities WHERE task_id=$1
         LIMIT 1",
    )
    .bind(task_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok((
        account
            .map(|id| format!("connector:{id}"))
            .unwrap_or_default(),
        owner,
    ))
}

/// Whether a run headed by `head` may bind `input`: both act for the same requester and reply to
/// the same audience. The inbox exception does not use this rule.
// The sources that admit person messages and settled answers call it (stage 2 slices b-d).
#[allow(dead_code)]
pub(crate) fn shares_with(head: &InputRow, input: &InputRow) -> bool {
    head.requester == input.requester && head.audience == input.audience
}

/// Binds `task_id`'s own pending input to it. Called when the Task is claimed.
pub(crate) async fn bind_own_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    now: i64,
) -> Result<()> {
    sqlx::query(
        "UPDATE supertag_v2_session_inputs SET task_id=$1,bound_at_ms=$2
         WHERE admitted_task_id=$1 AND task_id IS NULL AND conversation_id IS NULL",
    )
    .bind(task_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Binds the input to `task_id`. `at_claim` marks a message joined at the Task's first claim.
pub(crate) async fn bind_in(
    tx: &mut Transaction<'_, Any>,
    input_id: &str,
    task_id: &str,
    at_claim: bool,
    now: i64,
) -> Result<()> {
    sqlx::query(
        "UPDATE supertag_v2_session_inputs SET task_id=$1,bound_at_ms=$2,
            bound_at_claim=CASE WHEN $3=1 THEN 1 ELSE bound_at_claim END
         WHERE input_id=$4",
    )
    .bind(task_id)
    .bind(now)
    .bind(i64::from(at_claim))
    .bind(input_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Returns the input to the queue: a message its harness withdrew waits for its own turn.
pub(crate) async fn unbind_in(tx: &mut Transaction<'_, Any>, input_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE supertag_v2_session_inputs SET task_id=NULL,bound_at_ms=NULL,bound_at_claim=0
         WHERE input_id=$1 AND conversation_id IS NULL",
    )
    .bind(input_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Everything `task_id` bound, in Session order.
// The sources that admit person messages and settled answers call it (stage 2 slices b-d).
#[allow(dead_code)]
pub(crate) async fn bound_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<Vec<InputRow>> {
    sqlx::query("SELECT * FROM supertag_v2_session_inputs WHERE task_id=$1 ORDER BY position")
        .bind(task_id)
        .fetch_all(&mut **tx)
        .await?
        .iter()
        .map(input_row)
        .collect()
}

/// The person's messages `task_id`'s Attempt `attempt_id` is given with its own input, oldest
/// first: the ones joined at the Task's first claim, and the ones an earlier Attempt of the Task
/// accepted while it ran. A redelivered Task presents them to its next Attempt; a lost claim of
/// the same Attempt presents the same ones again.
pub(crate) async fn replayed_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    attempt_id: &str,
) -> Result<Vec<JoinedMessage>> {
    let rows = sqlx::query(
        "SELECT f.task_id,f.prompt,f.accepted_at_ms FROM supertag_v2_session_inputs i
         JOIN supertag_v2_tasks f ON f.task_id=i.admitted_task_id
         WHERE i.task_id=$1 AND i.kind=$2 AND i.admitted_task_id<>$1
           AND (i.bound_at_claim=1 OR i.offer_attempt_id<>$3)
         ORDER BY i.position",
    )
    .bind(task_id)
    .bind(InputKind::Person as i64)
    .bind(attempt_id)
    .fetch_all(&mut **tx)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(JoinedMessage {
                task_id: row.try_get("task_id")?,
                text: row.try_get("prompt")?,
                sent_at_ms: row
                    .try_get::<Option<i64>, _>("accepted_at_ms")?
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// Settles what `task_id`'s lost Attempt `lost_attempt_id` was offered when the Task is
/// redelivered. A message on its way to the Attempt, or one it may have read, is covered by the
/// redelivery: it is bound to the Task, its own turn is settled, and the next Attempt is given
/// it ([`replayed_in`]). A message it was never given falls back to its own turn.
pub(crate) async fn redeliver_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    lost_attempt_id: &str,
    now: i64,
) -> Result<()> {
    let taken: Vec<(String, String)> = sqlx::query_as(
        "SELECT input_id,admitted_task_id FROM supertag_v2_session_inputs
         WHERE offer_task_id=$1 AND offer_attempt_id=$2 AND offer_state IN ($3,$4)
         ORDER BY position",
    )
    .bind(task_id)
    .bind(lost_attempt_id)
    .bind(LiveInputState::Dispatching as i64)
    .bind(LiveInputState::Unknown as i64)
    .fetch_all(&mut **tx)
    .await?;
    let result = format!("Input accepted by Task {task_id}.");
    for (input_id, follower) in &taken {
        sqlx::query(
            "UPDATE supertag_v2_session_inputs SET offer_state=$1,acknowledgement_deadline_ms=NULL,
                task_id=$2,bound_at_ms=$3 WHERE input_id=$4",
        )
        .bind(LiveInputState::Accepted as i64)
        .bind(task_id)
        .bind(now)
        .bind(input_id)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "UPDATE supertag_v2_tasks SET state=$1,result=$2
             WHERE task_id=$3 AND state=$4 AND attempt_id IS NULL",
        )
        .bind(TaskState::Succeeded as i64)
        .bind(&result)
        .bind(follower)
        .bind(TaskState::Queued as i64)
        .execute(&mut **tx)
        .await?;
    }
    if !taken.is_empty() {
        crate::reply_progress::follow_up_in(tx, task_id).await?;
    }
    sqlx::query(
        "UPDATE supertag_v2_session_inputs SET offer_state=$1
         WHERE offer_task_id=$2 AND offer_attempt_id=$3 AND offer_state=$4",
    )
    .bind(LiveInputState::Rejected as i64)
    .bind(task_id)
    .bind(lost_attempt_id)
    .bind(LiveInputState::Pending as i64)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests;
