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
//!
//! Pacing: at most one unprompted post reaches a person's conversation or a surface thread in
//! [`PACE_MS`]. A later one is held: it stays out of the conversation, posts no reply, and counts
//! as nothing unread. When the window ends, the held posts go out together: in a conversation
//! each takes its place as the newest message, and in a surface thread they post as one reply,
//! the newest in full under a list of the earlier ones' first lines. A person's message to the
//! Tag there releases them at once, before the Tag answers. Only Schedule fires are paced in a
//! conversation, since clients show no other unprompted turn before it finishes; on a surface
//! every unprompted turn is. A reported Objective status or a wait for approvals never waits.
use sqlx::{Any, Transaction};
use supertag_protocol::v2::{AttentionSummary, FinishTaskRequest, ObjectiveSignal, Task};

use crate::store::Result;

/// Days `describe tag` counts.
pub(crate) const WINDOW_DAYS: u32 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Prior fires of one Schedule its next prompt counts.
const SCHEDULE_FIRES: i64 = 10;
/// The least time between two unprompted posts to one person or thread.
pub(crate) const PACE_MS: i64 = 30 * 60 * 1000;
/// Held posts that have not gone out yet; `h` is the conversation history row.
pub(crate) const NOT_HELD: &str = "NOT EXISTS (SELECT 1 FROM supertag_v2_proactive_posts hp
    WHERE hp.task_id=h.task_id AND hp.held_until_ms IS NOT NULL AND hp.released_at_ms IS NULL)";

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

/// Whether a person is waiting on this turn: their message started or joined it, or they acted
/// on its approval.
pub(crate) async fn person_turn_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<bool> {
    Ok(turn_in(tx, task).await? == Turn::Person)
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
/// counted, posted, held, or quiet; a person's turn answers the Session's recent unprompted
/// messages.
pub(crate) async fn finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: &FinishTaskRequest,
    now: i64,
) -> Result<()> {
    match turn_in(tx, task).await? {
        Turn::Unprompted if task.state() == supertag_protocol::v2::TaskState::Succeeded => {
            let conversation: Option<(i64, String)> = sqlx::query_as(
                "SELECT accepted_order,principal FROM supertag_v2_conversation_messages WHERE task_id=$1",
            )
            .bind(&task.task_id)
            .fetch_optional(&mut **tx)
            .await?;
            let audience = match &conversation {
                Some((_, principal)) => format!("conversation:{principal}"),
                None => match crate::store::reply_route_in(tx, task).await? {
                    Some(route) => thread_audience(&route)?,
                    None => return Ok(()),
                },
            };
            let fired: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM supertag_v2_schedule_fires WHERE task_id=$1")
                    .bind(&task.task_id)
                    .fetch_optional(&mut **tx)
                    .await?;
            // A conversation shows only a Schedule's turn after it finishes, so only that one
            // can wait there; a reported change or a wait for approvals always goes out.
            let paced = !task.quiet
                && (fired.is_some() || conversation.is_none())
                && input.objective_signal == ObjectiveSignal::Progress as i32
                && input.waiting_approval_ids.is_empty();
            let held_until = if paced {
                held_until_in(tx, &task.tag_id, &audience, now).await?
            } else {
                None
            };
            let delivered = (!task.quiet && held_until.is_none()).then_some(now);
            sqlx::query("INSERT INTO supertag_v2_proactive_posts (task_id,tag_id,session_id,conversation_order,posted_at_ms,quiet,audience,held_until_ms,delivered_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(task_id) DO NOTHING")
                .bind(&task.task_id).bind(&task.tag_id).bind(&task.session_id)
                .bind(conversation.map(|(order, _)| order)).bind(now).bind(i64::from(task.quiet))
                .bind(&audience).bind(held_until).bind(delivered)
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

/// A surface thread as a pacing audience.
fn thread_audience(route: &sqlx::any::AnyRow) -> Result<String> {
    use sqlx::Row;
    Ok(format!(
        "thread:{} {} {}",
        route.try_get::<String, _>("account_id")?,
        route.try_get::<String, _>("conversation_id")?,
        route
            .try_get::<Option<String>, _>("thread_id")?
            .unwrap_or_default()
    ))
}

/// Until when a new unprompted post to `audience` waits: with the posts already waiting there, or
/// until [`PACE_MS`] after the last one delivered; `None` when it may go out now.
async fn held_until_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    audience: &str,
    now: i64,
) -> Result<Option<i64>> {
    let waiting: Option<i64> = sqlx::query_scalar(
        "SELECT MIN(held_until_ms) FROM supertag_v2_proactive_posts
         WHERE tag_id=$1 AND audience=$2 AND held_until_ms IS NOT NULL AND released_at_ms IS NULL",
    )
    .bind(tag)
    .bind(audience)
    .fetch_one(&mut **tx)
    .await?;
    if waiting.is_some() {
        return Ok(waiting);
    }
    let last: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(delivered_at_ms) FROM supertag_v2_proactive_posts
         WHERE tag_id=$1 AND audience=$2 AND quiet=0",
    )
    .bind(tag)
    .bind(audience)
    .fetch_one(&mut **tx)
    .await?;
    Ok(last.map(|last| last + PACE_MS).filter(|until| *until > now))
}

/// Whether a finished turn's post is waiting for its window.
pub(crate) async fn held_in(tx: &mut Transaction<'_, Any>, task_id: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM supertag_v2_proactive_posts WHERE task_id=$1 AND held_until_ms IS NOT NULL AND released_at_ms IS NULL",
    )
    .bind(task_id)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

/// Delivers the posts waiting for `audience`, oldest first. In a conversation each becomes the
/// newest message; in a surface thread they post as one reply. Returns whether any went out.
pub(crate) async fn release_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    audience: &str,
    now: i64,
) -> Result<bool> {
    let held: Vec<String> = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_proactive_posts
         WHERE tag_id=$1 AND audience=$2 AND held_until_ms IS NOT NULL AND released_at_ms IS NULL
         ORDER BY posted_at_ms,task_id",
    )
    .bind(tag)
    .bind(audience)
    .fetch_all(&mut **tx)
    .await?;
    let Some(newest) = held.last() else {
        return Ok(false);
    };
    sqlx::query("UPDATE supertag_v2_proactive_posts SET released_at_ms=$1, delivered_at_ms=$1 WHERE tag_id=$2 AND audience=$3 AND held_until_ms IS NOT NULL AND released_at_ms IS NULL")
        .bind(now).bind(tag).bind(audience)
        .execute(&mut **tx).await?;
    if audience.starts_with("conversation:") {
        for task_id in &held {
            // It reaches the conversation now, so it takes the newest place and counts unread.
            let order = crate::store::next_order(tx).await?;
            sqlx::query(
                "UPDATE supertag_v2_conversation_messages SET accepted_order=$1 WHERE task_id=$2",
            )
            .bind(order)
            .bind(task_id)
            .execute(&mut **tx)
            .await?;
            sqlx::query(
                "UPDATE supertag_v2_proactive_posts SET conversation_order=$1 WHERE task_id=$2",
            )
            .bind(order)
            .bind(task_id)
            .execute(&mut **tx)
            .await?;
            sqlx::query("INSERT INTO supertag_v2_watch_append SELECT 3, 1, task_id, tag_id, session_id, objective_id, '', conversation, owner FROM supertag_v2_watch_tasks WHERE task_id=$1")
                .bind(task_id).execute(&mut **tx).await?;
        }
    } else {
        let mut earlier = Vec::with_capacity(held.len() - 1);
        for task_id in &held[..held.len() - 1] {
            let task = crate::store::task_in(tx, task_id).await?;
            earlier.push(first_line(task.result.as_deref().unwrap_or_default()));
        }
        let task = crate::store::task_in(tx, newest).await?;
        let name: Option<String> = sqlx::query_scalar(
            "SELECT COALESCE(name, tag_id) FROM supertag_v2_tags WHERE tag_id=$1",
        )
        .bind(tag)
        .fetch_optional(&mut **tx)
        .await?;
        let text = released_text(
            name.as_deref().unwrap_or(tag),
            &earlier,
            task.result.as_deref().unwrap_or_default(),
        );
        let order = crate::store::next_order(tx).await?;
        crate::store::enqueue_reply_text(tx, &task, order, &text).await?;
    }
    Ok(true)
}

/// Releases the posts waiting for a person who just wrote to the Tag in a surface thread, so
/// they arrive before the Tag's answer. Called when the person's turn is claimed.
pub(crate) async fn claimed_in(tx: &mut Transaction<'_, Any>, task: &Task, now: i64) -> Result<()> {
    let waiting: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM supertag_v2_proactive_posts WHERE tag_id=$1 AND held_until_ms IS NOT NULL AND released_at_ms IS NULL LIMIT 1",
    )
    .bind(&task.tag_id)
    .fetch_optional(&mut **tx)
    .await?;
    if waiting.is_none() || turn_in(tx, task).await? != Turn::Person {
        return Ok(());
    }
    if let Some(route) = crate::store::reply_route_in(tx, task).await? {
        release_in(tx, &task.tag_id, &thread_audience(&route)?, now).await?;
    }
    Ok(())
}

/// Releases every group whose window has ended. Returns how many groups went out.
pub(crate) async fn release_due_in(tx: &mut Transaction<'_, Any>, now: i64) -> Result<u64> {
    let due: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT tag_id,audience FROM supertag_v2_proactive_posts
         WHERE held_until_ms IS NOT NULL AND held_until_ms<=$1 AND released_at_ms IS NULL",
    )
    .bind(now)
    .fetch_all(&mut **tx)
    .await?;
    let mut released = 0;
    for (tag, audience) in due {
        if release_in(tx, &tag, &audience, now).await? {
            released += 1;
        }
    }
    Ok(released)
}

fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim();
    let mut short: String = line.chars().take(200).collect();
    if short.len() < line.len() {
        short.push('…');
    }
    short
}

/// One reply for posts released together: the newest in full under the earlier ones' first lines.
fn released_text(tag: &str, earlier: &[String], newest: &str) -> String {
    if earlier.is_empty() {
        return newest.to_owned();
    }
    let count = earlier.len();
    let mut text = format!(
        "{count} earlier update{} from {tag}:\n",
        if count == 1 { "" } else { "s" }
    );
    for line in earlier {
        text.push_str("• ");
        text.push_str(line);
        text.push('\n');
    }
    text.push('\n');
    text.push_str(newest);
    text
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

impl crate::Store {
    /// Delivers the held posts whose window has ended.
    pub async fn sweep_attention(&self) -> Result<u64> {
        let now = self.execution_now_ms();
        // Most passes find nothing to do; only take the write lock when they might.
        let due: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM supertag_v2_proactive_posts WHERE held_until_ms IS NOT NULL AND held_until_ms<=$1 AND released_at_ms IS NULL LIMIT 1",
        )
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        if due.is_none() {
            return Ok(0);
        }
        let _wake = self.hint_after_commit();
        let (mut tx, _) = self.write().await?;
        let released = release_due_in(&mut tx, now).await?;
        tx.commit().await?;
        Ok(released)
    }
}
