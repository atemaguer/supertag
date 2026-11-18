//! Work started by an owned Attempt and kept in a separate Session.
pub(crate) mod automatic;
pub(crate) mod continuation;
pub(crate) mod questions;
pub(crate) mod reports;

use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, HostAuthority, Store, StoreError,
    conversations::work_session_in,
    objectives::work_session_admission_in,
    store::{
        Result, insert_delegated_task_in, insert_task_from_snapshot, invalid, lease_is_live, name,
        owned, task_row,
    },
};

pub(crate) const CHILD: i64 = 1;
pub(crate) const REPORT: i64 = 2;
const MAX_PER_TURN: i64 = 4;
const MAX_OPEN: i64 = 8;
/// A Tag's open Work Sessions by default, and the most it may set.
pub(crate) const DEFAULT_MAX_WORK_SESSIONS: u32 = 8;
const MAX_WORK_SESSIONS: u32 = 64;
const MAX_RUNNING: i64 = 4;
const SESSION_PREFIX: &str = "work/";

pub(crate) fn reserved_session(session_id: &str) -> bool {
    session_id.starts_with(SESSION_PREFIX)
}

pub(crate) struct WorkSessionTaskScope {
    pub(crate) kind: i64,
    pub(crate) task_id: String,
    pub(crate) work_session_id: String,
}

/// Approval decisions can schedule a new Task in the same Session. Its
/// coordination authority still comes from the original Work Session Task.
pub(crate) async fn task_scope_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<Option<WorkSessionTaskScope>> {
    // A continued child has its own immutable starter, so its direct relation
    // takes precedence over the prior child in its approval ancestry.
    if let Some(row) = sqlx::query(
        "SELECT kind,task_id,work_session_id FROM supertag_v2_work_session_tasks WHERE task_id=$1",
    )
    .bind(task_id)
    .fetch_optional(&mut **tx)
    .await?
    {
        return Ok(Some(WorkSessionTaskScope {
            kind: row.try_get("kind")?,
            task_id: row.try_get("task_id")?,
            work_session_id: row.try_get("work_session_id")?,
        }));
    }
    let rows = sqlx::query(
        "WITH RECURSIVE lineage(task_id) AS (
             SELECT CAST($1 AS TEXT)
             UNION
             SELECT w.task_id FROM supertag_v2_approval_waits w
             JOIN lineage l ON l.task_id=w.continuation_task_id
         ) SELECT scoped.kind,scoped.task_id,scoped.work_session_id
           FROM lineage l JOIN supertag_v2_work_session_tasks scoped ON scoped.task_id=l.task_id
           LIMIT 2",
    )
    .bind(task_id)
    .fetch_all(&mut **tx)
    .await?;
    match rows.as_slice() {
        [] => Ok(None),
        [row] => Ok(Some(WorkSessionTaskScope {
            kind: row.try_get("kind")?,
            task_id: row.try_get("task_id")?,
            work_session_id: row.try_get("work_session_id")?,
        })),
        _ => Err(StoreError::PermissionDenied),
    }
}

pub(crate) async fn task_kind_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<Option<i64>> {
    Ok(task_scope_in(tx, task_id).await?.map(|scope| scope.kind))
}

/// Include leased claims and unsettled execution when reserving the parent Session's capacity.
pub(crate) async fn can_claim_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<bool> {
    if !reserved_session(&task.session_id) {
        return Ok(true);
    }
    let running: Option<i64> = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*)
                 FROM supertag_v2_work_sessions other
                 JOIN supertag_v2_tasks active ON active.task_id=other.latest_task_id
                 WHERE other.parent_tag_id=pending.parent_tag_id
                   AND other.parent_session_id=pending.parent_session_id
                   AND active.task_id<>$1 AND (active.state IN ($2,$3,$4) OR active.cleanup_pending=1))
         FROM supertag_v2_work_sessions pending WHERE pending.latest_task_id=$1",
    )
    .bind(&task.task_id)
    .bind(TaskState::Claimed as i64)
    .bind(TaskState::Running as i64)
    .bind(TaskState::Uncertain as i64)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(running.is_some_and(|count| count < MAX_RUNNING))
}

async fn insert_child_in(
    tx: &mut Transaction<'_, Any>,
    order: i64,
    parent: &Task,
    objective_id: Option<&str>,
    target: &str,
    session_id: &str,
    prompt: &str,
) -> Result<Task> {
    if target == parent.tag_id {
        return insert_task_from_snapshot(tx, order, parent, session_id, prompt).await;
    }
    let objective = objective_id.ok_or(StoreError::PermissionDenied)?;
    let team: Option<String> =
        sqlx::query_scalar("SELECT team_id FROM supertag_v2_objectives WHERE objective_id=$1")
            .bind(objective)
            .fetch_one(&mut **tx)
            .await?;
    let team = team.ok_or_else(|| {
        StoreError::FailedPrecondition("the Objective must name a Team to delegate work".into())
    })?;
    let member: Option<String> = sqlx::query_scalar(
        "SELECT tag_id FROM supertag_v2_team_members WHERE team_id=$1 AND tag_id=$2",
    )
    .bind(team)
    .bind(target)
    .fetch_optional(&mut **tx)
    .await?;
    if member.is_none() {
        return Err(StoreError::PermissionDenied);
    }
    let host: Option<String> = sqlx::query_scalar(
        "SELECT h.host_id FROM supertag_v2_hosts h
         WHERE h.generation>0 AND h.revoked_at_ms IS NULL
           AND (h.all_tags=1 OR EXISTS (
               SELECT 1 FROM supertag_v2_host_tags scope WHERE scope.host_id=h.host_id AND scope.tag_id=$1))
         LIMIT 1",
    )
    .bind(target)
    .fetch_optional(&mut **tx)
    .await?;
    if host.is_none() {
        return Err(StoreError::FailedPrecondition(
            "the delegated Tag has no registered Worker Host".into(),
        ));
    }
    // Keep the policy composer's larger async state off the same-Tag path.
    Box::pin(insert_delegated_task_in(
        tx, order, parent, objective, target, session_id, prompt,
    ))
    .await
}

/// The harness a new Work Session names, when it differs from the parent Task's: `None` runs
/// the target Tag's own. Work delegated to another Tag runs that Tag's harness.
async fn work_session_harness_in(
    tx: &mut Transaction<'_, Any>,
    parent: &Task,
    target: &str,
    requested: Option<&str>,
) -> Result<Option<HarnessKind>> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    let harness = crate::policy::harness_for_name(requested).ok_or_else(|| {
        invalid("unknown Work Session harness: use codex, claude-code, openai-agents, opencode, or cursor")
    })?;
    if target != parent.tag_id {
        let own: Option<i64> =
            sqlx::query_scalar("SELECT harness_kind FROM supertag_v2_tags WHERE tag_id=$1")
                .bind(target)
                .fetch_optional(&mut **tx)
                .await?;
        if own.is_some_and(|own| own != harness as i64) {
            return Err(StoreError::FailedPrecondition(format!(
                "work delegated to Tag {target} runs that Tag's harness; start it without a harness"
            )));
        }
        return Ok(None);
    }
    if harness == parent.harness_kind() {
        return Ok(None);
    }
    if supertag_protocol::shared_execution::environment(parent.policy_snapshot.as_ref()).is_some()
        && harness != HarnessKind::Cursor
    {
        return Err(StoreError::FailedPrecondition(
            "this Tag's shared execution environment runs only Cursor; start the Work Session without a harness".into(),
        ));
    }
    Ok(Some(harness))
}

/// Direct owner Objective reports may start follow-up work. An approval
/// continuation remains scoped to its original report and cannot gain this right.
pub(crate) async fn may_start_in(tx: &mut Transaction<'_, Any>, parent: &Task) -> Result<bool> {
    if crate::mailbox::private_session(&parent.session_id)
        || crate::memories::review_session(&parent.session_id)
    {
        return Ok(false);
    }
    match task_scope_in(tx, &parent.task_id).await? {
        None => Ok(!reserved_session(&parent.session_id)),
        Some(scope) if scope.kind == REPORT && scope.task_id == parent.task_id => {
            let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_work_sessions w JOIN supertag_v2_objectives o ON o.objective_id=w.objective_id WHERE w.work_session_id=$1 AND o.owner_tag_id=$2 AND o.session_id=$3 AND o.status NOT IN (5,6) AND EXISTS (SELECT 1 FROM supertag_v2_work_session_reports r WHERE r.work_session_id=w.work_session_id AND r.report_task_id=$4)")
                .bind(scope.work_session_id).bind(&parent.tag_id).bind(&parent.session_id).bind(&parent.task_id).fetch_one(&mut **tx).await?;
            Ok(count == 1)
        }
        _ => Ok(false),
    }
}

/// A Tag's `max_work_sessions` being written: as requested, else as it was, else the default.
pub(crate) async fn max_work_sessions_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    requested: Option<u32>,
) -> Result<u32> {
    if let Some(value) = requested {
        if !(1..=MAX_WORK_SESSIONS).contains(&value) {
            return Err(invalid("max_work_sessions must be from 1 to 64"));
        }
        return Ok(value);
    }
    let current: Option<i64> =
        sqlx::query_scalar("SELECT max_work_sessions FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag_id)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(current.map_or(DEFAULT_MAX_WORK_SESSIONS, |value| value as u32))
}

/// How many Work Sessions a Tag started that are open, across all its conversations and
/// Objectives, and how many it may have.
pub(crate) async fn open_count_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<(u32, u32)> {
    let open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_work_sessions WHERE parent_tag_id=$1 AND closed_at_ms IS NULL",
    )
    .bind(tag)
    .fetch_one(&mut **tx)
    .await?;
    let max: Option<i64> =
        sqlx::query_scalar("SELECT max_work_sessions FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag)
            .fetch_optional(&mut **tx)
            .await?;
    Ok((
        open as u32,
        max.map_or(DEFAULT_MAX_WORK_SESSIONS, |value| value as u32),
    ))
}

/// Closes a Work Session. Closing a closed one changes nothing.
pub(crate) async fn close_in(
    tx: &mut Transaction<'_, Any>,
    work_session_id: &str,
    reason: WorkSessionCloseReason,
    now: i64,
) -> Result<()> {
    let closed = sqlx::query("UPDATE supertag_v2_work_sessions SET closed_at_ms=$1, close_reason=$2 WHERE work_session_id=$3 AND closed_at_ms IS NULL")
        .bind(now).bind(reason as i64).bind(work_session_id).execute(&mut **tx).await?
        .rows_affected();
    // Its Tag or an operator reporting the work done lands it in a `merge` Workspace.
    if closed > 0
        && matches!(
            reason,
            WorkSessionCloseReason::Tag | WorkSessionCloseReason::Operator
        )
    {
        crate::workspace_landings::session_done_in(tx, work_session_id).await?;
    }
    Ok(())
}

/// A closed Objective's Work Sessions close.
pub(crate) async fn close_objective_in(
    tx: &mut Transaction<'_, Any>,
    objective_id: &str,
    now: i64,
) -> Result<()> {
    let open: Vec<String> = sqlx::query_scalar("SELECT work_session_id FROM supertag_v2_work_sessions WHERE objective_id=$1 AND closed_at_ms IS NULL")
        .bind(objective_id).fetch_all(&mut **tx).await?;
    sqlx::query("UPDATE supertag_v2_work_sessions SET closed_at_ms=$1, close_reason=$2 WHERE objective_id=$3 AND closed_at_ms IS NULL")
        .bind(now).bind(WorkSessionCloseReason::ObjectiveClosed as i64).bind(objective_id)
        .execute(&mut **tx).await?;
    // A closed Objective's work is done: its Work Sessions land in a `merge` Workspace.
    for work_session_id in open {
        crate::workspace_landings::session_done_in(tx, &work_session_id).await?;
    }
    Ok(())
}

/// Why each of these Work Sessions closed, for the closed ones.
pub(crate) async fn closed_reasons_in(
    tx: &mut Transaction<'_, Any>,
    work_session_ids: &[&str],
) -> Result<std::collections::HashMap<String, i32>> {
    let mut closed = std::collections::HashMap::new();
    for chunk in work_session_ids.chunks(crate::store::ID_BATCH) {
        let sql = format!(
            "SELECT work_session_id, close_reason FROM supertag_v2_work_sessions
             WHERE closed_at_ms IS NOT NULL AND work_session_id IN ({})",
            crate::store::placeholders(1, chunk.len())
        );
        let mut query = sqlx::query(&sql);
        for id in chunk {
            query = query.bind(*id);
        }
        for row in query.fetch_all(&mut **tx).await? {
            closed.insert(
                row.try_get("work_session_id")?,
                row.try_get::<i64, _>("close_reason")? as i32,
            );
        }
    }
    Ok(closed)
}

/// A Work Session with no turn, continuation, or delivery change for this long closes.
pub(crate) const IDLE_CLOSE_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// Closes Work Sessions idle for [`IDLE_CLOSE_MS`]: their latest turn and report finished that
/// long ago, so the limit cannot fill up with abandoned work.
pub(crate) async fn close_idle_in(tx: &mut Transaction<'_, Any>, now: i64) -> Result<u64> {
    let cutoff = now - IDLE_CLOSE_MS;
    Ok(sqlx::query(
        "UPDATE supertag_v2_work_sessions SET closed_at_ms=$1, close_reason=$2
         WHERE closed_at_ms IS NULL
           AND EXISTS (SELECT 1 FROM supertag_v2_tasks t WHERE t.task_id=supertag_v2_work_sessions.latest_task_id
                       AND t.state IN ($3,$4,$5) AND t.cleanup_pending=0
                       AND COALESCE(t.completed_at_ms, t.accepted_at_ms, 0) <= $6)
           AND NOT EXISTS (SELECT 1 FROM supertag_v2_work_session_reports r
                           JOIN supertag_v2_tasks report ON report.task_id=r.report_task_id
                           WHERE r.child_task_id=supertag_v2_work_sessions.latest_task_id
                             AND (report.state NOT IN ($3,$4,$5)
                                  OR COALESCE(report.completed_at_ms, report.accepted_at_ms, 0) > $6))",
    )
    .bind(now)
    .bind(WorkSessionCloseReason::Idle as i64)
    .bind(TaskState::Succeeded as i64)
    .bind(TaskState::Failed as i64)
    .bind(TaskState::Cancelled as i64)
    .bind(cutoff)
    .execute(&mut **tx)
    .await?
    .rows_affected())
}

/// Continuing a Work Session closed for 14 days without activity reopens it, when its Tag is
/// under its limit; at the limit, the continuation is refused with the open Work Sessions, as a
/// start is. An explicit close (the Tag, an operator, a pulled delivery, its Objective ending) is
/// final.
pub(crate) async fn reopen_in(
    tx: &mut Transaction<'_, Any>,
    parent: &Task,
    work_session_id: &str,
) -> Result<()> {
    let row = sqlx::query(
        "SELECT closed_at_ms, close_reason FROM supertag_v2_work_sessions WHERE work_session_id=$1",
    )
    .bind(work_session_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(());
    };
    if row.try_get::<Option<i64>, _>("closed_at_ms")?.is_none() {
        return Ok(());
    }
    let reason = WorkSessionCloseReason::try_from(row.try_get::<i64, _>("close_reason")? as i32)
        .unwrap_or_default();
    if reason != WorkSessionCloseReason::Idle {
        let why = match reason {
            WorkSessionCloseReason::Tag => "the Tag closed it",
            WorkSessionCloseReason::Operator => "an operator closed it",
            WorkSessionCloseReason::DeliveryPulled => "its delivery was pulled",
            WorkSessionCloseReason::ObjectiveClosed => "its Objective closed",
            WorkSessionCloseReason::Upgrade => "it had finished before an upgrade",
            _ => "it was closed",
        };
        return Err(StoreError::FailedPrecondition(format!(
            "this Work Session was closed ({why}); start a new one"
        )));
    }
    let (open, max) = open_count_in(tx, &parent.tag_id).await?;
    if open >= max {
        return Err(limit_refusal_in(tx, parent, open, max).await?);
    }
    sqlx::query("UPDATE supertag_v2_work_sessions SET closed_at_ms=NULL, close_reason=0 WHERE work_session_id=$1")
        .bind(work_session_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// The refusal at the limit: the open Work Sessions, so the Tag can continue or close one. A
/// Work Session in a conversation this turn may not see shows no title.
async fn limit_refusal_in(
    tx: &mut Transaction<'_, Any>,
    parent: &Task,
    open: u32,
    max: u32,
) -> Result<StoreError> {
    let kind = task_kind_in(tx, &parent.task_id).await?;
    let viewer = crate::tag_sessions::viewer_in(tx, parent.clone(), kind).await?;
    let rows = sqlx::query(
        "SELECT ws.work_session_id, ws.title, ws.parent_session_id, t.state,
                CASE WHEN EXISTS (SELECT 1 FROM supertag_v2_work_session_reports r WHERE r.child_task_id=t.task_id)
                     THEN 1 ELSE 0 END AS reported,
                CASE WHEN EXISTS (SELECT 1 FROM supertag_v2_work_session_questions q WHERE q.task_id=t.task_id
                        AND q.published_at_ms IS NOT NULL AND q.answer_task_id IS NULL) THEN 1 ELSE 0 END AS asking
         FROM supertag_v2_work_sessions ws JOIN supertag_v2_tasks t ON t.task_id=ws.latest_task_id
         WHERE ws.parent_tag_id=$1 AND ws.closed_at_ms IS NULL
         ORDER BY ws.created_order LIMIT 64",
    )
    .bind(&parent.tag_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut lines = vec![format!(
        "This Tag has {open} of {max} Work Sessions open, its limit, so no new one started. Continue one of this conversation's with continue_session, or close one that is done with close_session, then try again."
    )];
    for row in rows {
        let id: String = row.try_get("work_session_id")?;
        let parent_session: String = row.try_get("parent_session_id")?;
        let state = match TaskState::try_from(row.try_get::<i64, _>("state")? as i32) {
            _ if row.try_get::<i32, _>("asking")? != 0 => "asking a question",
            Ok(TaskState::Queued) => "queued",
            Ok(TaskState::Claimed | TaskState::Running) => "running",
            Ok(TaskState::Uncertain) => "interrupted",
            _ if row.try_get::<i32, _>("reported")? != 0 => "reported",
            Ok(TaskState::Failed) => "failed",
            Ok(TaskState::Cancelled) => "cancelled",
            _ => "finished",
        };
        let visible = match &viewer {
            Some(viewer) => {
                crate::tag_sessions::sees_session_in(tx, viewer, &parent_session).await?
            }
            None => parent_session == parent.session_id,
        };
        if visible {
            let title: String = row.try_get("title")?;
            let here = if parent_session == parent.session_id {
                ", this conversation"
            } else {
                ""
            };
            lines.push(format!("- {id} \"{title}\" ({state}{here})"));
        } else {
            lines.push(format!(
                "- {id} ({state}, in a conversation this turn cannot see)"
            ));
        }
    }
    Ok(StoreError::FailedPrecondition(lines.join("\n")))
}

impl Store {
    /// The `close_session` tool: closes a Work Session the turn's Tag started that the turn may
    /// see.
    pub async fn close_attempt_work_session(
        &self,
        host: &HostAuthority,
        input: &CloseAttemptWorkSessionRequest,
    ) -> Result<WorkSession> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        name("Work Session ID", &input.work_session_id)?;
        let (mut tx, _) = self.write().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let parent = task_row(&row)?;
        let now = self.execution_now_ms();
        if parent.state() != TaskState::Running || !lease_is_live(&row, now)? {
            return Err(StoreError::FailedPrecondition(
                "closing work requires a live running Attempt".into(),
            ));
        }
        if !may_start_in(&mut tx, &parent).await? {
            return Err(StoreError::PermissionDenied);
        }
        let missing = || StoreError::NotFound("Work Session was not found".into());
        let session: Option<String> = sqlx::query_scalar(
            "SELECT parent_session_id FROM supertag_v2_work_sessions WHERE work_session_id=$1 AND parent_tag_id=$2",
        )
        .bind(&input.work_session_id)
        .bind(&parent.tag_id)
        .fetch_optional(&mut *tx)
        .await?;
        let session = session.ok_or_else(missing)?;
        let kind = task_kind_in(&mut tx, &parent.task_id).await?;
        let visible = match crate::tag_sessions::viewer_in(&mut tx, parent.clone(), kind).await? {
            Some(viewer) => {
                crate::tag_sessions::sees_session_in(&mut tx, &viewer, &session).await?
            }
            None => session == parent.session_id,
        };
        if !visible {
            return Err(missing());
        }
        close_in(
            &mut tx,
            &input.work_session_id,
            WorkSessionCloseReason::Tag,
            now,
        )
        .await?;
        let result = work_session_in(&mut tx, &input.work_session_id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn start_work_session(
        &self,
        host: &HostAuthority,
        input: &StartWorkSessionRequest,
    ) -> Result<WorkSession> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        name("operation ID", &input.operation_id)?;
        let title = input.title.split_whitespace().collect::<Vec<_>>().join(" ");
        let instruction = input.instruction.trim();
        if title.is_empty() || title.encode_utf16().count() > 120 || title.contains('\0') {
            return Err(invalid("Work Session title must contain 1–120 characters"));
        }
        if instruction.is_empty()
            || instruction.encode_utf16().count() > 8_000
            || instruction.contains('\0')
        {
            return Err(invalid(
                "Work Session instruction must contain 1–8,000 characters",
            ));
        }
        let (mut tx, order) = self.write().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let parent = task_row(&row)?;
        if !may_start_in(&mut tx, &parent).await? {
            return Err(StoreError::PermissionDenied);
        }
        let target = input.target_tag_id.as_deref().unwrap_or(&parent.tag_id);
        name("target Tag ID", target)?;
        let harness =
            work_session_harness_in(&mut tx, &parent, target, input.harness.as_deref()).await?;
        let workspace = parent
            .workspace
            .as_ref()
            .map(|spec| spec.workspace_id.as_str());
        if let Some(requested) = &input.workspace_id {
            name("Workspace ID", requested)?;
        }
        // A Work Session always works in its parent Task's Workspace; a request may only repeat it.
        if let Some(requested) = input
            .workspace_id
            .as_deref()
            .filter(|requested| Some(*requested) != workspace)
        {
            return Err(StoreError::FailedPrecondition(match workspace {
                Some(accepted) => format!(
                    "Workspace {requested} is not this Task's Workspace {accepted}; a Work Session works in {accepted}, so name no Workspace"
                ),
                None => format!(
                    "Workspace {requested} is not available: this Task has no Workspace, so name none"
                ),
            }));
        }
        // A start that names no harness keeps the digest it had before starts could name one, so a
        // retry of an operation recorded then still matches.
        let content = match &input.harness {
            None => serde_json::to_vec(&(&title, instruction, workspace, target))?,
            Some(harness) => {
                serde_json::to_vec(&(&title, instruction, workspace, target, harness))?
            }
        };
        let digest = format!("{:x}", Sha256::digest(content));
        let prior = sqlx::query("SELECT child_task_id,request_digest FROM supertag_v2_work_session_starts WHERE starter_task_id=$1 AND operation_id=$2")
            .bind(&parent.task_id).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "operation ID was used with different Work Session content".into(),
                ));
            }
            let result = crate::conversations::work_session_child_in(
                &mut tx,
                &prior.try_get::<String, _>("child_task_id")?,
            )
            .await?;
            tx.rollback().await?;
            return Ok(result);
        }
        let continued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_work_session_continuations WHERE starter_task_id=$1 AND operation_id=$2")
            .bind(&parent.task_id).bind(&input.operation_id).fetch_one(&mut *tx).await?;
        if continued != 0 {
            return Err(StoreError::Conflict(
                "operation ID was used to continue a Work Session".into(),
            ));
        }
        let now = self.execution_now_ms();
        if parent.state() != TaskState::Running || !lease_is_live(&row, now)? {
            return Err(StoreError::FailedPrecondition(
                "starting work requires a live running Attempt".into(),
            ));
        }
        let objective_id = work_session_admission_in(&mut tx, &parent, now).await?;
        continuation::budget_in(&mut tx, &parent).await?;
        let (open, max) = open_count_in(&mut tx, &parent.tag_id).await?;
        if open >= max {
            return Err(limit_refusal_in(&mut tx, &parent, open, max).await?);
        }
        if let Some(harness) = harness
            && !crate::placement::bound_host_runs_in(&mut tx, &parent.tag_id, harness, now).await?
        {
            return Err(StoreError::FailedPrecondition(format!(
                "no Worker Host bound to Tag {} runs {}; start the Work Session without a harness or on one a bound Worker Host runs",
                parent.tag_id,
                crate::placement::harness_name(harness)
            )));
        }
        let id = format!("{SESSION_PREFIX}{}", Uuid::new_v4());
        let prompt = format!("Work Session: {title}\n\n{instruction}");
        let mut child = insert_child_in(
            &mut tx,
            order,
            &parent,
            objective_id.as_deref(),
            target,
            &id,
            &prompt,
        )
        .await?;
        if let Some(harness) = harness {
            crate::store::retarget_harness_in(&mut tx, &mut child, harness).await?;
        }
        let allocation = crate::budget_pool::child_in(
            &mut tx,
            &parent,
            objective_id.as_deref(),
            child.execution_limits.as_ref(),
        )
        .await?;
        crate::budget_pool::set_in(&mut tx, &mut child, allocation).await?;
        // Its permissions are checked against the harness's capabilities as for any Task; a
        // Work Session that names a harness is refused now instead of waiting forever.
        if harness.is_some()
            && let Some((_, reason)) = crate::placement::unsupported_by_harness(&child)
        {
            return Err(StoreError::FailedPrecondition(format!(
                "{reason}. Start the Work Session without a harness, or on one that can run its accepted permissions"
            )));
        }
        sqlx::query("INSERT INTO supertag_v2_work_sessions (work_session_id,title,parent_tag_id,parent_session_id,starter_task_id,tag_id,latest_task_id,objective_id,created_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(&id).bind(&title).bind(&parent.tag_id).bind(&parent.session_id)
            .bind(&parent.task_id).bind(&child.tag_id).bind(&child.task_id).bind(&objective_id)
            .bind(order).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind,starter_task_id) VALUES ($1,$2,$3,$4)")
            .bind(&child.task_id).bind(&id).bind(CHILD).bind(&parent.task_id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_work_session_starts (starter_task_id,operation_id,request_digest,work_session_id,child_task_id) VALUES ($1,$2,$3,$4,$5)")
            .bind(&parent.task_id).bind(&input.operation_id).bind(digest).bind(&id).bind(&child.task_id).execute(&mut *tx).await?;
        if let Some(objective_id) = objective_id {
            sqlx::query("INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind) VALUES ($1,$2,'work')")
                .bind(&child.task_id).bind(objective_id).execute(&mut *tx).await?;
        }
        let result = work_session_in(&mut tx, &id).await?;
        tx.commit().await?;
        Ok(result)
    }
}

impl ControlPlane {
    pub fn attempt_work_sessions_service(
        &self,
    ) -> attempt_work_sessions_server::AttemptWorkSessionsServer<Self> {
        attempt_work_sessions_server::AttemptWorkSessionsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl attempt_work_sessions_server::AttemptWorkSessions for ControlPlane {
    async fn start(
        &self,
        request: Request<StartWorkSessionRequest>,
    ) -> std::result::Result<Response<WorkSession>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .start_work_session(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn r#continue(
        &self,
        request: Request<ContinueWorkSessionRequest>,
    ) -> std::result::Result<Response<WorkSession>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .continue_work_session(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn ask(
        &self,
        request: Request<AskWorkSessionQuestionRequest>,
    ) -> std::result::Result<Response<WorkSessionQuestion>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .ask_work_session_question(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn close(
        &self,
        request: Request<CloseAttemptWorkSessionRequest>,
    ) -> std::result::Result<Response<WorkSession>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .close_attempt_work_session(&host, request.get_ref())
                .await?,
        ))
    }
}
