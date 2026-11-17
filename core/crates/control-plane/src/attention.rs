//! What deserves a person's attention: the one decision the reply outbox, the conversation views,
//! and the unread counts share.
//!
//! A turn no person is waiting on (a Schedule fire, an Objective notice, a memory review, or an
//! inbox turn) may finish quietly with `stay_quiet`: it posts nothing and its conversation does not
//! show it, though its Task, events, and result stay in the Tag's history. A person's message is
//! always answered: a quiet finish from any other turn, including one a person's message joined,
//! is ignored and the reply posts.
//!
//! The unprompted turns that had someone to reach are counted per Tag: each posted reply, whether
//! a person read it in their conversation or answered it in the same Session within a day, and
//! each check that stayed quiet. `describe tag` and the next Schedule fire's prompt show them.
use sqlx::{Any, Transaction};
use supertag_protocol::v2::{AttentionSummary, FinishTaskRequest, ObjectiveSignal, Task};

use crate::store::Result;

/// Days `describe tag` counts.
pub(crate) const WINDOW_DAYS: u32 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Prior fires of one Schedule its next prompt counts.
const SCHEDULE_FIRES: i64 = 10;

/// Whether a finished turn's reply is delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Attention {
    Post,
    Quiet,
}

pub(crate) fn attention(task: &Task) -> Attention {
    if task.quiet {
        Attention::Quiet
    } else {
        Attention::Post
    }
}

/// Who a turn answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Turn {
    /// A person's message, a message joined into it, or an action a person took.
    Person,
    /// A Work Session's own or report turn: the report is the point.
    WorkSession,
    /// A Schedule fire or Objective notice that may reach a person.
    Unprompted,
    /// A memory review or inbox turn, which reaches no one.
    Internal,
}

async fn turn_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<Turn> {
    if crate::memories::review_session(&task.session_id)
        || crate::mailbox::private_session(&task.session_id)
    {
        return Ok(Turn::Internal);
    }
    if crate::work_sessions::reserved_session(&task.session_id)
        || crate::work_sessions::task_scope_in(tx, &task.task_id)
            .await?
            .is_some()
    {
        return Ok(Turn::WorkSession);
    }
    let unprompted: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM supertag_v2_schedule_fires WHERE task_id=$1
         UNION ALL SELECT 1 FROM supertag_v2_objective_notices WHERE task_id=$1",
    )
    .bind(&task.task_id)
    .fetch_optional(&mut **tx)
    .await?;
    if unprompted.is_none() {
        return Ok(Turn::Person);
    }
    let joined: Option<String> =
        sqlx::query_scalar("SELECT input_id FROM supertag_v2_live_inputs WHERE task_id=$1 LIMIT 1")
            .bind(&task.task_id)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(if joined.is_some() {
        Turn::Person
    } else {
        Turn::Unprompted
    })
}

/// Whether no person is waiting on this turn, so it may finish quietly.
pub(crate) async fn may_stay_quiet_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<bool> {
    Ok(matches!(
        turn_in(tx, task).await?,
        Turn::Unprompted | Turn::Internal
    ))
}

/// Whether a running turn's successful finish is quiet. A reported Objective status or a wait for
/// approvals always posts, and so does every turn a person is waiting on.
pub(crate) async fn quiet_finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: &FinishTaskRequest,
) -> Result<bool> {
    if !input.quiet || !input.succeeded {
        return Ok(false);
    }
    if input.objective_signal == ObjectiveSignal::Progress as i32
        && input.waiting_approval_ids.is_empty()
        && may_stay_quiet_in(tx, task).await?
    {
        return Ok(true);
    }
    supertag_protocol::terminal_text::warn(&format!(
        "Task {} asked to finish quietly, but a person is waiting on it or it reported a change; its reply posts",
        task.task_id
    ));
    Ok(false)
}

/// Called once when a running turn finishes. A succeeded unprompted turn with someone to reach is
/// counted, posted or quiet; a person's turn answers the Session's recent unprompted messages.
pub(crate) async fn finish_in(tx: &mut Transaction<'_, Any>, task: &Task, now: i64) -> Result<()> {
    match turn_in(tx, task).await? {
        Turn::Unprompted if task.state() == supertag_protocol::v2::TaskState::Succeeded => {
            let conversation_order: Option<i64> = sqlx::query_scalar(
                "SELECT accepted_order FROM supertag_v2_conversation_messages WHERE task_id=$1",
            )
            .bind(&task.task_id)
            .fetch_optional(&mut **tx)
            .await?;
            if conversation_order.is_none()
                && crate::store::reply_route_in(tx, task).await?.is_none()
            {
                return Ok(());
            }
            sqlx::query("INSERT INTO supertag_v2_proactive_posts (task_id,tag_id,session_id,conversation_order,posted_at_ms,quiet) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id) DO NOTHING")
                .bind(&task.task_id).bind(&task.tag_id).bind(&task.session_id)
                .bind(conversation_order).bind(now).bind(i64::from(task.quiet))
                .execute(&mut **tx).await?;
        }
        // A person's turn finishing answers what the Tag posted in its Session the day before.
        Turn::Person => {
            let at = now;
            sqlx::query("UPDATE supertag_v2_proactive_posts SET answered_at_ms=$1 WHERE tag_id=$2 AND session_id=$3 AND quiet=0 AND answered_at_ms IS NULL AND posted_at_ms<=$1 AND posted_at_ms>=$4")
                .bind(at).bind(&task.tag_id).bind(&task.session_id).bind(at - DAY_MS)
                .execute(&mut **tx).await?;
        }
        _ => {}
    }
    Ok(())
}

/// A person read their conversation with a Tag up to `order`.
pub(crate) async fn read_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    tag: &str,
    order: i64,
    now: i64,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_proactive_posts SET read_at_ms=$1 WHERE tag_id=$2 AND quiet=0 AND read_at_ms IS NULL AND conversation_order<=$3 AND session_id IN (SELECT session_id FROM supertag_v2_conversations WHERE principal=$4 AND tag_id=$2)")
        .bind(now).bind(tag).bind(order).bind(principal)
        .execute(&mut **tx).await?;
    Ok(())
}

struct Counts {
    posted: i64,
    read: i64,
    answered: i64,
    quiet: i64,
}

const COUNTS: &str = "COUNT(CASE WHEN p.quiet=0 THEN 1 END) AS posted,
    COUNT(CASE WHEN p.quiet=0 AND p.read_at_ms IS NOT NULL THEN 1 END) AS read,
    COUNT(CASE WHEN p.quiet=0 AND p.answered_at_ms IS NOT NULL THEN 1 END) AS answered,
    COUNT(CASE WHEN p.quiet=1 THEN 1 END) AS quiet";

fn counts(row: &sqlx::any::AnyRow) -> Result<Counts> {
    use sqlx::Row;
    Ok(Counts {
        posted: row.try_get("posted")?,
        read: row.try_get("read")?,
        answered: row.try_get("answered")?,
        quiet: row.try_get("quiet")?,
    })
}

/// How the Tag's unprompted messages of the last [`WINDOW_DAYS`] were received.
pub(crate) async fn summary_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    now: i64,
) -> Result<AttentionSummary> {
    let row = sqlx::query(&format!(
        "SELECT {COUNTS} FROM supertag_v2_proactive_posts p WHERE p.tag_id=$1 AND p.posted_at_ms>=$2"
    ))
    .bind(tag)
    .bind(now - i64::from(WINDOW_DAYS) * DAY_MS)
    .fetch_one(&mut **tx)
    .await?;
    let counts = counts(&row)?;
    let count = |value: i64| u32::try_from(value).unwrap_or(u32::MAX);
    Ok(AttentionSummary {
        posted: count(counts.posted),
        read: count(counts.read),
        answered: count(counts.answered),
        quiet: count(counts.quiet),
        window_days: WINDOW_DAYS,
    })
}

/// One line for a Schedule's next prompt on how its last fires were received, so the Tag can
/// calibrate when to speak. `None` before it has any.
pub(crate) async fn schedule_line_in(
    tx: &mut Transaction<'_, Any>,
    schedule_id: &str,
) -> Result<Option<String>> {
    let row = sqlx::query(&format!(
        "SELECT {COUNTS} FROM (SELECT q.quiet,q.read_at_ms,q.answered_at_ms FROM supertag_v2_proactive_posts q
             JOIN supertag_v2_schedule_fires f ON f.task_id=q.task_id
             WHERE f.schedule_id=$1 ORDER BY q.posted_at_ms DESC LIMIT $2) p"
    ))
    .bind(schedule_id)
    .bind(SCHEDULE_FIRES)
    .fetch_one(&mut **tx)
    .await?;
    let counts = counts(&row)?;
    if counts.posted + counts.quiet == 0 {
        return Ok(None);
    }
    let plural = |n: i64, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    Ok(Some(format!(
        "Of this Schedule's last {}: {} posted ({} read, {} answered); {} stayed quiet.",
        plural(counts.posted + counts.quiet, "fire", "fires"),
        counts.posted,
        counts.read,
        counts.answered,
        counts.quiet,
    )))
}
