//! A Tag's memory: a few short notes it keeps of what it cannot look up again, and the daily
//! review that tidies them.
//!
//! The log (Tasks and their events) is the record; notes are pointers and lessons, not copies. A
//! Tag writes them with `remember` and `forget`. Each call is staged against the turn and takes
//! effect only when that turn succeeds, as Schedules and `report_objective` do. A note takes the
//! turn's audience: private to the person whose conversation wrote it, or shared. A turn sees the
//! shared notes and its own person's notes, never another person's, by the rule
//! `tag_sessions.rs` uses for Sessions.
//!
//! The maintenance sweep queues a review turn in the Tag's reserved `memory:` Session once a day
//! after enough work. The review reads the Tag's shared Sessions and rewrites its shared notes;
//! it has no tool that reaches anyone, and it ends with `stay_quiet` (attention.rs), so it posts
//! nothing. It runs read-only: of the Tag's actions it keeps only reading files.
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, HostAuthority, Store, StoreError,
    store::{Result, insert_task, invalid, lease_is_live, name, next_order, owned, task_row},
    tag_sessions::Audience,
};

pub(crate) const STAGED: i64 = MemoryState::Staged as i64;
pub(crate) const ACTIVE: i64 = MemoryState::Active as i64;
pub(crate) const FORGETTING: i64 = MemoryState::Forgetting as i64;

/// Characters in one note.
pub(crate) const NOTE_MAX_CHARS: usize = 500;
/// Notes one turn may see: the shared ones plus its person's.
const MAX_NOTES: usize = 40;
/// Characters of the notes one turn sees, which every turn loads.
const MAX_CONTEXT_CHARS: usize = 6_000;
/// Notes one turn may write or forget.
const PER_TURN: i64 = 10;
/// Root turns finished since the last review before the next one, and the least time between.
const REVIEW_AFTER_TURNS: i64 = 10;
const REVIEW_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
/// Sessions a review turn's prompt names.
const REVIEW_SESSIONS: i64 = 30;
const SWEEP_BATCH: i64 = 32;

const SESSION_PREFIX: &str = "memory:";

/// The reserved Session a Tag's review turns run in.
pub(crate) fn review_session(session: &str) -> bool {
    session.starts_with(SESSION_PREFIX)
}

fn review_session_of(tag: &str) -> String {
    format!("{SESSION_PREFIX}{tag}")
}

/// Whether a Tag being written keeps memory: as requested, else as it was. A new Tag does.
pub(crate) async fn enabled_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    requested: Option<bool>,
) -> Result<bool> {
    if let Some(memory) = requested {
        return Ok(memory);
    }
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT memory FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag_id)
            .fetch_optional(&mut **tx)
            .await?
            .is_none_or(|memory| memory != 0),
    )
}

pub(crate) async fn tag_keeps_memory_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT memory FROM supertag_v2_tags WHERE tag_id=$1 AND retired_at_ms IS NULL",
    )
    .bind(tag_id)
    .fetch_optional(&mut **tx)
    .await?
        == Some(1))
}

/// A started outside event, such as a GitHub or Linear webhook, never writes notes: its text is
/// whatever someone outside put in an issue or pull request.
pub(crate) fn external_origin(task: &Task) -> bool {
    use surface_location_scope::Provider;
    matches!(
        task.policy_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.origin.as_ref())
            .and_then(|origin| origin.scope.as_ref())
            .and_then(|scope| scope.provider.as_ref()),
        Some(Provider::Github(_) | Provider::Linear(_))
    )
}

/// The notes a turn sees and writes: `Some(None)` shared, `Some(Some(principal))` private to
/// that person. `None` when its audience is a private Session with no recorded person, which
/// neither sees nor writes notes.
pub(crate) async fn turn_audience_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
) -> Result<Option<Option<String>>> {
    Ok(
        match crate::tag_sessions::audience_in(tx, &task.tag_id, &task.session_id).await? {
            Audience::Shared => Some(None),
            Audience::Private(Some(principal)) => Some(Some(principal)),
            Audience::Private(None) => None,
        },
    )
}

/// Whether a root turn may write notes: its Tag keeps memory, an outside event did not start it,
/// and it has an audience. `kind` is its Work Session scope, if any.
pub(crate) async fn may_remember_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    kind: Option<i64>,
) -> Result<bool> {
    if !tag_keeps_memory_in(tx, &task.tag_id).await? {
        return Ok(false);
    }
    Ok(may_write(task, kind) && turn_audience_in(tx, task).await?.is_some())
}

/// The turn-shape half of [`may_remember_in`], which reads nothing.
fn may_write(task: &Task, kind: Option<i64>) -> bool {
    !(matches!(kind, Some(kind) if kind != crate::work_sessions::REPORT)
        || crate::work_sessions::reserved_session(&task.session_id)
        || task.session_id.starts_with("surface-status:")
        || external_origin(task))
}

/// What a turn starts with: whether it may write notes, and its portfolio's notes section when
/// `root` (it has a portfolio). Reads the Tag's memory flag and the turn's audience once.
pub(crate) async fn turn_memory_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    kind: Option<i64>,
    root: bool,
) -> Result<(bool, Option<String>)> {
    let writes = may_write(task, kind);
    if !(writes || root) || !tag_keeps_memory_in(tx, &task.tag_id).await? {
        return Ok((false, None));
    }
    let Some(audience) = turn_audience_in(tx, task).await? else {
        return Ok((false, None));
    };
    let section = if root {
        Some(notes_section(tx, task, audience.as_deref(), writes).await?)
    } else {
        None
    };
    Ok((writes, section))
}

/// Called when a turn starts: the notes its context lists were seen now. Only a root turn of a
/// Tag that keeps memory lists notes, those of its audience.
pub(crate) async fn started_in(tx: &mut Transaction<'_, Any>, task: &Task, now: i64) -> Result<()> {
    let kind = crate::work_sessions::task_scope_in(tx, &task.task_id)
        .await?
        .map(|scope| scope.kind);
    if crate::tag_sessions::viewer_in(tx, task.clone(), kind)
        .await?
        .is_none()
        || !tag_keeps_memory_in(tx, &task.tag_id).await?
    {
        return Ok(());
    }
    let Some(audience) = turn_audience_in(tx, task).await? else {
        return Ok(());
    };
    sqlx::query("UPDATE supertag_v2_tag_memories SET last_seen_at_ms=$1 WHERE tag_id=$2 AND (audience_principal IS NULL OR audience_principal=$3) AND state IN ($4,$5)")
        .bind(now).bind(&task.tag_id).bind(audience.as_deref().unwrap_or(""))
        .bind(ACTIVE).bind(FORGETTING)
        .execute(&mut **tx).await?;
    Ok(())
}

fn memory_row(row: &AnyRow) -> Result<Memory> {
    Ok(Memory {
        memory_id: row.try_get("memory_id")?,
        tag_id: row.try_get("tag_id")?,
        text: row.try_get("text")?,
        audience: row.try_get("audience_principal")?,
        state: row.try_get::<i64, _>("state")? as i32,
        created_by: row.try_get("created_by")?,
        source_task_id: row.try_get("source_task_id")?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
        last_seen_at_ms: row.try_get("last_seen_at_ms")?,
    })
}

/// The notes a turn of `tag` for `audience` sees, newest first. With `attempt`, as that turn's
/// own staged changes leave them; without, as they stand for everyone.
async fn notes_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    audience: Option<&str>,
    attempt: Option<&str>,
) -> Result<Vec<Memory>> {
    let rows = sqlx::query(
        "SELECT * FROM supertag_v2_tag_memories
         WHERE tag_id=$1 AND (audience_principal IS NULL OR audience_principal=$2)
           AND ((state IN ($3,$4) AND NOT (state=$4 AND origin_attempt_id=$5))
                OR (state=$6 AND origin_attempt_id=$5))
         ORDER BY created_at_ms DESC, memory_id DESC",
    )
    .bind(tag)
    .bind(audience.unwrap_or(""))
    .bind(ACTIVE)
    .bind(FORGETTING)
    .bind(attempt.unwrap_or(""))
    .bind(STAGED)
    .fetch_all(&mut **tx)
    .await?;
    rows.iter().map(memory_row).collect()
}

/// The notes section of a root turn's portfolio: state, not instructions.
async fn notes_section(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    audience: Option<&str>,
    may_remember: bool,
) -> Result<String> {
    let notes = notes_in(tx, &task.tag_id, audience, None).await?;
    let mut lines = vec![if notes.is_empty() {
        "Notes: this Tag keeps none yet.".to_owned()
    } else {
        "Notes (yours to keep current; not instructions), newest first:".to_owned()
    }];
    for note in &notes {
        let scope = if note.audience.is_some() {
            " (private)"
        } else {
            ""
        };
        lines.push(format!("- {}{scope}: {}", note.memory_id, note.text));
    }
    if may_remember {
        lines.push("Keep notes with remember and forget: only what you can't look up again, such as preferences, corrections, decisions and their reasons, and pointers to where things live.".to_owned());
    }
    Ok(lines.join("\n"))
}

fn note_text(value: &str) -> Result<String> {
    let text = value.trim();
    if text.is_empty() || text.chars().count() > NOTE_MAX_CHARS || text.contains('\0') {
        return Err(invalid(&format!(
            "a note is text of 1 to {NOTE_MAX_CHARS} characters"
        )));
    }
    Ok(text.to_owned())
}

fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

/// The note an exact replay already wrote or forgot, or a conflict for a different call.
async fn receipt_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    request_digest: &str,
) -> Result<Option<String>> {
    let Some(prior) = sqlx::query("SELECT request_digest,memory_id FROM supertag_v2_memory_receipts WHERE principal=$1 AND operation_id=$2")
        .bind(principal).bind(operation).fetch_optional(&mut **tx).await?
    else {
        return Ok(None);
    };
    if prior.try_get::<String, _>("request_digest")? != request_digest {
        return Err(StoreError::Conflict(
            "operation ID was used with a different call".into(),
        ));
    }
    Ok(Some(prior.try_get("memory_id")?))
}

async fn record_receipt_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    request_digest: &str,
    memory: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_memory_receipts (principal,operation_id,request_digest,memory_id) VALUES ($1,$2,$3,$4)")
        .bind(principal).bind(operation).bind(request_digest).bind(memory)
        .execute(&mut **tx).await?;
    Ok(())
}

/// A live running turn that may write notes, its Attempt, and its audience.
async fn memory_turn_in(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    attempt: Option<&InspectAttemptRequest>,
    now_ms: i64,
) -> Result<(Task, String, Option<String>)> {
    let attempt = attempt.ok_or_else(|| invalid("Attempt identity is required"))?;
    let row = owned(
        tx,
        host,
        &attempt.task_id,
        &attempt.attempt_id,
        &attempt.lease_token,
    )
    .await?;
    if row.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(&row, now_ms)?
    {
        return Err(StoreError::FailedPrecondition(
            "keeping notes requires a live running Attempt".into(),
        ));
    }
    let task = task_row(&row)?;
    let kind = crate::work_sessions::task_scope_in(tx, &task.task_id)
        .await?
        .map(|scope| scope.kind);
    if !may_remember_in(tx, &task, kind).await? {
        return Err(StoreError::PermissionDenied);
    }
    let audience = turn_audience_in(tx, &task)
        .await?
        .ok_or(StoreError::PermissionDenied)?;
    Ok((task, attempt.attempt_id.clone(), audience))
}

async fn writes_in(tx: &mut Transaction<'_, Any>, attempt: &str) -> Result<()> {
    let writes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_tag_memories WHERE origin_attempt_id=$1",
    )
    .bind(attempt)
    .fetch_one(&mut **tx)
    .await?;
    if writes >= PER_TURN {
        return Err(StoreError::FailedPrecondition(format!(
            "a turn may write or forget at most {PER_TURN} notes"
        )));
    }
    Ok(())
}

/// A note this turn sees, by ID.
async fn visible_note_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    audience: Option<&str>,
    attempt: &str,
    id: &str,
) -> Result<AnyRow> {
    name("note ID", id)?;
    let row = sqlx::query("SELECT * FROM supertag_v2_tag_memories WHERE memory_id=$1 AND tag_id=$2 AND (audience_principal IS NULL OR audience_principal=$3)")
        .bind(id).bind(&task.tag_id).bind(audience.unwrap_or(""))
        .fetch_optional(&mut **tx).await?;
    match row {
        Some(row)
            if row.try_get::<i64, _>("state")? != STAGED
                || row
                    .try_get::<Option<String>, _>("origin_attempt_id")?
                    .as_deref()
                    == Some(attempt) =>
        {
            Ok(row)
        }
        _ => Err(StoreError::NotFound(format!("note {id} was not found"))),
    }
}

/// Stages forgetting a visible note: its own staged note goes at once.
async fn stage_forget_in(
    tx: &mut Transaction<'_, Any>,
    row: &AnyRow,
    attempt: &str,
    now: i64,
) -> Result<()> {
    let id: String = row.try_get("memory_id")?;
    let state: i64 = row.try_get("state")?;
    let origin: Option<String> = row.try_get("origin_attempt_id")?;
    match (state, origin.as_deref()) {
        (STAGED, _) => {
            sqlx::query("DELETE FROM supertag_v2_tag_memories WHERE memory_id=$1")
                .bind(&id)
                .execute(&mut **tx)
                .await?;
        }
        (FORGETTING, Some(origin)) if origin == attempt => {}
        (FORGETTING, _) => {
            return Err(StoreError::Conflict(format!(
                "another turn is changing note {id}"
            )));
        }
        _ => {
            sqlx::query("UPDATE supertag_v2_tag_memories SET state=$1,origin_attempt_id=$2,updated_at_ms=$3 WHERE memory_id=$4 AND state=$5")
                .bind(FORGETTING).bind(attempt).bind(now).bind(&id).bind(ACTIVE)
                .execute(&mut **tx).await?;
        }
    }
    Ok(())
}

/// Refuses a note that would take this turn's notes past their limits, naming the oldest notes
/// to forget or merge.
fn check_limits(notes: &[Memory], replaced: Option<&str>, text: &str) -> Result<()> {
    let kept: Vec<&Memory> = notes
        .iter()
        .filter(|note| Some(note.memory_id.as_str()) != replaced)
        .collect();
    let chars: usize = kept
        .iter()
        .map(|note| note.text.chars().count())
        .sum::<usize>()
        + text.chars().count();
    if kept.len() < MAX_NOTES && chars <= MAX_CONTEXT_CHARS {
        return Ok(());
    }
    let oldest = kept
        .iter()
        .rev()
        .take(5)
        .map(|note| {
            let short: String = note.text.chars().take(60).collect();
            format!("{} \"{short}\"", note.memory_id)
        })
        .collect::<Vec<_>>()
        .join("; ");
    Err(StoreError::FailedPrecondition(format!(
        "your notes are full (at most {MAX_NOTES} notes and {MAX_CONTEXT_CHARS} characters). Forget notes that no longer matter, or merge several into one with remember and replaces. Oldest: {oldest}"
    )))
}

impl Store {
    /// The `remember` tool: stages a note, which takes effect when the turn succeeds.
    pub async fn attempt_remember(
        &self,
        host: &HostAuthority,
        input: &AttemptRememberRequest,
    ) -> Result<AttemptMemoryResponse> {
        name("operation ID", &input.operation_id)?;
        let text = note_text(&input.text)?;
        let now = self.execution_now_ms();
        let (mut tx, _) = self.write().await?;
        let (task, attempt, audience) =
            memory_turn_in(&mut tx, host, input.attempt.as_ref(), now).await?;
        // Replays are per Task: a retried Attempt reuses its call identities.
        let principal = format!("task:{}", task.task_id);
        let request = digest(&("remember", &attempt, &text, &input.replaces))?;
        let id = match receipt_in(&mut tx, &principal, &input.operation_id, &request).await? {
            Some(prior) => prior,
            None => {
                writes_in(&mut tx, &attempt).await?;
                let notes =
                    notes_in(&mut tx, &task.tag_id, audience.as_deref(), Some(&attempt)).await?;
                check_limits(&notes, input.replaces.as_deref(), &text)?;
                if let Some(replaced) = &input.replaces {
                    let row =
                        visible_note_in(&mut tx, &task, audience.as_deref(), &attempt, replaced)
                            .await?;
                    stage_forget_in(&mut tx, &row, &attempt, now).await?;
                }
                let id = format!("mem_{}", Uuid::new_v4().simple());
                sqlx::query("INSERT INTO supertag_v2_tag_memories (memory_id,tag_id,audience_principal,text,state,created_by,source_task_id,origin_attempt_id,replaces,created_at_ms,updated_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)")
                    .bind(&id).bind(&task.tag_id).bind(&audience).bind(&text).bind(STAGED)
                    .bind(format!("tag:{}", task.tag_id)).bind(&task.task_id).bind(&attempt)
                    .bind(&input.replaces).bind(now)
                    .execute(&mut *tx).await?;
                record_receipt_in(&mut tx, &principal, &input.operation_id, &request, &id).await?;
                id
            }
        };
        let response = response_in(&mut tx, &task, audience.as_deref(), &attempt, &id).await?;
        tx.commit().await?;
        Ok(response)
    }

    /// The `forget` tool: stages forgetting a note this turn sees.
    pub async fn attempt_forget(
        &self,
        host: &HostAuthority,
        input: &AttemptForgetRequest,
    ) -> Result<AttemptMemoryResponse> {
        name("operation ID", &input.operation_id)?;
        let now = self.execution_now_ms();
        let (mut tx, _) = self.write().await?;
        let (task, attempt, audience) =
            memory_turn_in(&mut tx, host, input.attempt.as_ref(), now).await?;
        let principal = format!("task:{}", task.task_id);
        let request = digest(&("forget", &attempt, &input.memory_id))?;
        if receipt_in(&mut tx, &principal, &input.operation_id, &request)
            .await?
            .is_none()
        {
            let row = visible_note_in(
                &mut tx,
                &task,
                audience.as_deref(),
                &attempt,
                &input.memory_id,
            )
            .await?;
            if row.try_get::<i64, _>("state")? == ACTIVE {
                writes_in(&mut tx, &attempt).await?;
            }
            stage_forget_in(&mut tx, &row, &attempt, now).await?;
            record_receipt_in(
                &mut tx,
                &principal,
                &input.operation_id,
                &request,
                &input.memory_id,
            )
            .await?;
        }
        let notes = notes_in(&mut tx, &task.tag_id, audience.as_deref(), Some(&attempt)).await?;
        tx.commit().await?;
        Ok(AttemptMemoryResponse {
            memory: None,
            notes,
        })
    }

    /// Notes the principal sees, newest first: an operator sees shared notes and clients'; a
    /// client sees shared notes and its own.
    pub async fn list_memories(
        &self,
        principal: &str,
        input: &ListMemoriesRequest,
    ) -> Result<ListMemoriesResponse> {
        crate::store::actor(principal)?;
        if let Some(tag) = &input.tag_id {
            name("Tag ID", tag)?;
        }
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query("SELECT * FROM supertag_v2_tag_memories WHERE ($1='' OR tag_id=$1) AND state IN ($2,$3) ORDER BY created_at_ms DESC, memory_id DESC LIMIT 2000")
            .bind(input.tag_id.as_deref().unwrap_or("")).bind(ACTIVE).bind(FORGETTING)
            .fetch_all(&mut *tx).await?;
        tx.commit().await?;
        let mut memories = vec![];
        for row in &rows {
            let memory = memory_row(row)?;
            if visible(principal, &memory) {
                memories.push(memory);
            }
        }
        Ok(ListMemoriesResponse { memories })
    }

    pub async fn get_memory(&self, principal: &str, id: &str) -> Result<Memory> {
        crate::store::actor(principal)?;
        name("note ID", id)?;
        let mut tx = self.pool.begin().await?;
        let memory = sqlx::query("SELECT * FROM supertag_v2_tag_memories WHERE memory_id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .as_ref()
            .map(memory_row)
            .transpose()?;
        tx.commit().await?;
        match memory {
            Some(memory) if memory.state != STAGED as i32 && visible(principal, &memory) => {
                Ok(memory)
            }
            _ => Err(StoreError::NotFound(format!("note {id} was not found"))),
        }
    }

    /// Deletes a note the principal sees, at once. Deleting it again is not found.
    pub async fn delete_memory(&self, principal: &str, id: &str) -> Result<Memory> {
        let memory = self.get_memory(principal, id).await?;
        let (mut tx, _) = self.write().await?;
        sqlx::query("DELETE FROM supertag_v2_tag_memories WHERE memory_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(memory)
    }

    /// Settles notes left by turns that no longer run, then queues each due review.
    pub async fn sweep_memory(&self) -> Result<u64> {
        let now = self.execution_now_ms();
        let stale: Option<String> = sqlx::query_scalar(&format!(
            "SELECT memory_id FROM supertag_v2_tag_memories WHERE state IN ($1,$2) AND {GONE} LIMIT 1"
        ))
        .bind(STAGED)
        .bind(FORGETTING)
        .bind(TaskState::Claimed as i64)
        .bind(TaskState::Running as i64)
        .fetch_optional(&self.pool)
        .await?;
        let due = due_reviews(&self.pool, now).await?;
        if stale.is_none() && due.is_empty() {
            return Ok(0);
        }
        let (mut tx, _) = self.write().await?;
        // A turn that no longer runs never succeeded: its staged changes never take effect.
        sqlx::query(&format!(
            "DELETE FROM supertag_v2_tag_memories WHERE state IN ($1,$2) AND {GONE}"
        ))
        .bind(STAGED)
        .bind(STAGED)
        .bind(TaskState::Claimed as i64)
        .bind(TaskState::Running as i64)
        .execute(&mut *tx)
        .await?;
        sqlx::query(&format!(
            "UPDATE supertag_v2_tag_memories SET state=$1,origin_attempt_id=NULL WHERE state=$2 AND {GONE}"
        ))
        .bind(ACTIVE)
        .bind(FORGETTING)
        .bind(TaskState::Claimed as i64)
        .bind(TaskState::Running as i64)
        .execute(&mut *tx)
        .await?;
        let mut queued = 0;
        for tag in due {
            if queue_review_in(&mut tx, &tag, now).await? {
                queued += 1;
            }
        }
        tx.commit().await?;
        Ok(queued)
    }
}

/// A note row staged or forgotten by a turn that no longer runs. `$3` and `$4` are the claimed
/// and running states.
const GONE: &str = "NOT EXISTS (SELECT 1 FROM supertag_v2_tasks t WHERE t.attempt_id=supertag_v2_tag_memories.origin_attempt_id AND t.state IN ($3,$4))";

/// Tags due a review: they keep memory, finished enough root turns since their last review, and
/// last reviewed long enough ago. A Tag never reviewed waits the same interval from its first
/// finished turn, so a new Tag's first few quick exchanges don't trigger a review at once.
async fn due_reviews(pool: &sqlx::AnyPool, now: i64) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT g.tag_id FROM supertag_v2_tags g
         WHERE g.memory=1 AND g.retired_at_ms IS NULL
           AND (g.memory_reviewed_at_ms<=$1
                OR (g.memory_reviewed_at_ms IS NULL AND EXISTS (
                    SELECT 1 FROM supertag_v2_tasks f
                    WHERE f.tag_id=g.tag_id AND f.state=$2 AND f.completed_at_ms<=$1)))
           AND (SELECT COUNT(*) FROM supertag_v2_tasks t
                WHERE t.tag_id=g.tag_id AND t.state=$2 AND t.completed_at_ms IS NOT NULL
                  AND t.completed_at_ms>COALESCE(g.memory_reviewed_at_ms,0)
                  AND substr(t.session_id,1,5)<>'work/' AND substr(t.session_id,1,7)<>'memory:')>=$3
         ORDER BY g.tag_id LIMIT $4",
    )
    .bind(now - REVIEW_INTERVAL_MS)
    .bind(TaskState::Succeeded as i64)
    .bind(REVIEW_AFTER_TURNS)
    .bind(SWEEP_BATCH)
    .fetch_all(pool)
    .await?)
}

/// Queues the Tag's review turn, unless one is still queued or running.
async fn queue_review_in(tx: &mut Transaction<'_, Any>, tag: &str, now: i64) -> Result<bool> {
    let session = review_session_of(tag);
    let open: Option<String> = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_tasks WHERE tag_id=$1 AND session_id=$2 AND state IN ($3,$4,$5) LIMIT 1",
    )
    .bind(tag)
    .bind(&session)
    .bind(TaskState::Queued as i64)
    .bind(TaskState::Claimed as i64)
    .bind(TaskState::Running as i64)
    .fetch_optional(&mut **tx)
    .await?;
    if open.is_some() {
        return Ok(false);
    }
    let since: Option<i64> =
        sqlx::query_scalar("SELECT memory_reviewed_at_ms FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag)
            .fetch_one(&mut **tx)
            .await?;
    let sessions: Vec<String> = sqlx::query_scalar(
        "SELECT session_id FROM supertag_v2_tasks
         WHERE tag_id=$1 AND state=$2 AND completed_at_ms>$3 AND session_id<>$4
         GROUP BY session_id ORDER BY MAX(completed_at_ms) DESC LIMIT $5",
    )
    .bind(tag)
    .bind(TaskState::Succeeded as i64)
    .bind(since.unwrap_or(0))
    .bind(&session)
    .bind(REVIEW_SESSIONS)
    .fetch_all(&mut **tx)
    .await?;
    let prompt = review_prompt(since, &sessions);
    let order = next_order(tx).await?;
    let task = Box::pin(insert_task(tx, order, tag, &session, &prompt)).await?;
    // The review reads the Tag's work and keeps notes; it changes nothing else. It runs read-only
    // in the Tag's Workspace, whatever else the Tag may do. Writing or running a command implies
    // reading, as harnesses read the Workspace in every mode.
    let reads = task.allowed_actions.iter().any(|action| {
        matches!(
            action.as_str(),
            "files:read" | "files:write" | "commands:execute"
        )
    });
    sqlx::query("UPDATE supertag_v2_tasks SET allowed_actions=$1 WHERE task_id=$2")
        .bind(if reads { r#"["files:read"]"# } else { "[]" })
        .bind(&task.task_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE supertag_v2_tags SET memory_reviewed_at_ms=$1,memory_review_task_id=$2 WHERE tag_id=$3")
        .bind(now)
        .bind(&task.task_id)
        .bind(tag)
        .execute(&mut **tx)
        .await?;
    Ok(true)
}

fn review_prompt(since: Option<i64>, sessions: &[String]) -> String {
    let since = match since.and_then(chrono::DateTime::from_timestamp_millis) {
        Some(at) => format!(
            "since {}",
            at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        ),
        None => "so far".to_owned(),
    };
    let mut text = format!(
        "Memory review. Review your work {since}. Read the Sessions below with read_session, and read_turn for detail; you may see only shared Sessions. Then update your notes: merge duplicates, replace what is stale, add only lasting lessons and pointers, and forget what no longer matters. Don't contact anyone. Finish by calling stay_quiet with one line saying what you changed."
    );
    if sessions.is_empty() {
        text.push_str("\nSessions: none listed; use list_sessions.");
    } else {
        text.push_str("\nSessions:");
        for session in sessions {
            text.push_str(&format!("\n- {session}"));
        }
    }
    text
}

/// Called when a turn finishes: its staged notes and forgetting take effect if it succeeded, and
/// are dropped otherwise.
pub(crate) async fn finish_in(tx: &mut Transaction<'_, Any>, task: &Task, now: i64) -> Result<()> {
    let Some(attempt) = &task.attempt_id else {
        return Ok(());
    };
    if task.state() == TaskState::Succeeded {
        sqlx::query("DELETE FROM supertag_v2_tag_memories WHERE origin_attempt_id=$1 AND state=$2")
            .bind(attempt)
            .bind(FORGETTING)
            .execute(&mut **tx)
            .await?;
        sqlx::query("UPDATE supertag_v2_tag_memories SET state=$1,origin_attempt_id=NULL,updated_at_ms=$2 WHERE origin_attempt_id=$3 AND state=$4")
            .bind(ACTIVE).bind(now).bind(attempt).bind(STAGED)
            .execute(&mut **tx).await?;
    } else {
        sqlx::query("DELETE FROM supertag_v2_tag_memories WHERE origin_attempt_id=$1 AND state=$2")
            .bind(attempt)
            .bind(STAGED)
            .execute(&mut **tx)
            .await?;
        sqlx::query("UPDATE supertag_v2_tag_memories SET state=$1,origin_attempt_id=NULL WHERE origin_attempt_id=$2 AND state=$3")
            .bind(ACTIVE).bind(attempt).bind(FORGETTING)
            .execute(&mut **tx).await?;
    }
    Ok(())
}

/// Retiring a Tag deletes its notes.
pub(crate) async fn retire_tag_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<()> {
    sqlx::query("DELETE FROM supertag_v2_tag_memories WHERE tag_id=$1")
        .bind(tag)
        .execute(&mut **tx)
        .await?;
    crate::native_memory::retire_tag_in(tx, tag).await
}

async fn response_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    audience: Option<&str>,
    attempt: &str,
    id: &str,
) -> Result<AttemptMemoryResponse> {
    let notes = notes_in(tx, &task.tag_id, audience, Some(attempt)).await?;
    let memory = notes.iter().find(|note| note.memory_id == id).cloned();
    Ok(AttemptMemoryResponse { memory, notes })
}

/// Whether the principal sees the note: its own conversation's, or as an operator, any shared
/// note or one a client's conversation holds.
fn visible(principal: &str, memory: &Memory) -> bool {
    crate::store::sees_owner(principal, memory.audience.as_deref().unwrap_or(""))
}

impl ControlPlane {
    pub fn memories_service(&self) -> memories_server::MemoriesServer<Self> {
        memories_server::MemoriesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_memory_service(&self) -> attempt_memory_server::AttemptMemoryServer<Self> {
        attempt_memory_server::AttemptMemoryServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl memories_server::Memories for ControlPlane {
    async fn list(
        &self,
        request: Request<ListMemoriesRequest>,
    ) -> std::result::Result<Response<ListMemoriesResponse>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .list_memories(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn get(
        &self,
        request: Request<GetMemoryRequest>,
    ) -> std::result::Result<Response<Memory>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .get_memory(&principal, &request.get_ref().memory_id)
                .await?,
        ))
    }

    async fn delete(
        &self,
        request: Request<GetMemoryRequest>,
    ) -> std::result::Result<Response<Memory>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .delete_memory(&principal, &request.get_ref().memory_id)
                .await?,
        ))
    }
    async fn reset_native(
        &self,
        request: Request<ResetNativeMemoryRequest>,
    ) -> std::result::Result<Response<ResetNativeMemoryResponse>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .reset_native_memory(&principal, request.get_ref())
                .await?,
        ))
    }
}

#[tonic::async_trait]
impl attempt_memory_server::AttemptMemory for ControlPlane {
    async fn remember(
        &self,
        request: Request<AttemptRememberRequest>,
    ) -> std::result::Result<Response<AttemptMemoryResponse>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .attempt_remember(&host, request.get_ref())
                .await?,
        ))
    }

    async fn forget(
        &self,
        request: Request<AttemptForgetRequest>,
    ) -> std::result::Result<Response<AttemptMemoryResponse>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store.attempt_forget(&host, request.get_ref()).await?,
        ))
    }
    async fn report_native(
        &self,
        request: Request<ReportNativeMemoryRequest>,
    ) -> std::result::Result<Response<ReportNativeMemoryResponse>, Status> {
        let host = self.host_authority(&request)?;
        self.store
            .report_native_memory(&host, request.get_ref())
            .await?;
        Ok(Response::new(ReportNativeMemoryResponse {}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, text: &str) -> Memory {
        Memory {
            memory_id: id.into(),
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn github_and_linear_events_never_write_notes() {
        use surface_location_scope::Provider;
        let task = |provider: Option<Provider>| Task {
            policy_snapshot: Some(TaskPolicySnapshot {
                origin: Some(SurfacePolicyOrigin {
                    scope: Some(SurfaceLocationScope { provider }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(external_origin(&task(Some(Provider::Github(
            GithubSurfaceRepository::default()
        )))));
        assert!(external_origin(&task(Some(Provider::Linear(
            LinearSurfaceTeam::default()
        )))));
        assert!(!external_origin(&task(Some(Provider::Slack(
            SlackSurfaceChannel::default()
        )))));
        assert!(!external_origin(&task(None)));
        assert!(!external_origin(&Task::default()));
    }

    #[test]
    fn full_notes_name_the_oldest_to_forget() {
        let notes: Vec<Memory> = (0..MAX_NOTES)
            .rev()
            .map(|index| note(&format!("mem_{index}"), "x"))
            .collect();
        let error = check_limits(&notes, None, "new").unwrap_err().to_string();
        assert!(
            error.contains("mem_0") && error.contains("Forget"),
            "{error}"
        );
        assert!(check_limits(&notes, Some("mem_3"), "new").is_ok());
        let long = vec![note("mem_a", &"y".repeat(MAX_CONTEXT_CHARS))];
        assert!(check_limits(&long, None, "z").is_err());
        assert!(check_limits(&long, Some("mem_a"), "z").is_ok());
    }
}
