//! The operator Inbox is a bounded read model over durable questions, Objective
//! limits, and uncertain execution. Decisions always revalidate their source.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, HostAuthority, Store, StoreError, objective_limits as limits,
    objectives::{objective_admission_in, objective_link_task_in},
    store::{Result, insert_task, invalid, lease_is_live, name, owned, task_in},
};

const SCAN: usize = 1_000;
const QUESTION_MAX: usize = 16_000;
const PREVIEW: usize = 500;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: String,
    objective_id: String,
    kind: i32,
    as_of_ms: i64,
    upper_order: i64,
    at: i64,
    key: String,
}
fn operator(principal: &str) -> Result<()> {
    if principal
        .strip_prefix("operator:")
        .is_none_or(str::is_empty)
    {
        return Err(StoreError::PermissionDenied);
    }
    name("operator principal", principal)
}
fn nonempty_text(value: &str, maximum: usize) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() || value.encode_utf16().count() > maximum || value.contains('\0') {
        return Err(invalid("text is empty or exceeds the supported length"));
    }
    Ok(value)
}
impl Store {
    pub async fn attempt_capabilities(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
    ) -> Result<AttemptCapabilities> {
        let mut tx = self.pool.begin().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        if row.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&row, self.execution_now_ms())?
        {
            return Err(StoreError::FailedPrecondition(
                "capabilities require a live running Attempt".into(),
            ));
        }
        let may_ask_objective_question = question_objective_in(&mut tx, &row, &attempt.task_id)
            .await?
            .is_some();
        let session: String = row.try_get("session_id")?;
        let scope = crate::work_sessions::task_scope_in(&mut tx, &attempt.task_id).await?;
        let kind = scope.as_ref().map(|scope| scope.kind);
        let is_root = !crate::work_sessions::reserved_session(&session) && kind.is_none();
        let task = crate::store::task_row(&row)?;
        let may_request_commit_review = kind == Some(crate::work_sessions::REPORT)
            && crate::commit_reviews::may_request_in(&mut tx, &task).await?;
        let may_continue_work_session =
            crate::work_sessions::continuation::may_continue_in(&mut tx, &task, scope.as_ref())
                .await?;
        let tag: String = row.try_get("tag_id")?;
        let may_use_workstream = match crate::teams::workstreams::workstream_for_task_in(
            &mut tx,
            &attempt.task_id,
            &tag,
        )
        .await
        {
            Ok(_) => true,
            Err(
                StoreError::FailedPrecondition(_)
                | StoreError::NotFound(_)
                | StoreError::PermissionDenied,
            ) => false,
            Err(error) => return Err(error),
        };
        tx.commit().await?;
        Ok(AttemptCapabilities {
            may_ask_objective_question,
            may_use_workstream,
            may_read_mailbox: is_root,
            may_send_tag_message: is_root,
            may_start_work_session: is_root && !crate::mailbox::private_session(&session),
            may_continue_work_session,
            may_ask_work_session_question: kind == Some(crate::work_sessions::CHILD),
            may_request_commit_review,
        })
    }

    pub async fn ask_question(
        &self,
        host: &HostAuthority,
        input: &AskQuestionRequest,
    ) -> Result<ObjectiveQuestion> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        name("operation ID", &input.operation_id)?;
        let text = nonempty_text(&input.text, QUESTION_MAX)?;
        let (mut tx, _) = self.write().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        // An exact durable Ask receipt remains replayable after Finish or expiry.
        if let Some(prior) =
            sqlx::query("SELECT * FROM supertag_v2_objective_questions WHERE attempt_id=$1")
                .bind(&attempt.attempt_id)
                .fetch_optional(&mut *tx)
                .await?
        {
            if prior.try_get::<String, _>("operation_id")? != input.operation_id
                || prior.try_get::<String, _>("text")? != text
            {
                return Err(StoreError::Conflict(
                    "this Attempt already asked a different question".into(),
                ));
            }
            let value = question_row(&prior)?;
            tx.rollback().await?;
            return Ok(value);
        }
        let now = self.execution_now_ms();
        if row.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&row, now)?
        {
            return Err(StoreError::FailedPrecondition(
                "asking requires a live running Attempt".into(),
            ));
        }
        let objective_id = question_objective_in(&mut tx, &row, &attempt.task_id)
            .await?
            .ok_or_else(|| {
                StoreError::FailedPrecondition(
                    "asking requires work by the owner of an open Objective".into(),
                )
            })?;
        sqlx::query("INSERT INTO supertag_v2_objective_questions (attempt_id,task_id,objective_id,operation_id,text,asked_at_ms) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(&attempt.attempt_id).bind(&attempt.task_id).bind(objective_id).bind(&input.operation_id).bind(text).bind(now).execute(&mut *tx).await?;
        let question = question_in(&mut tx, &attempt.task_id, false).await?;
        tx.commit().await?;
        Ok(question)
    }

    pub async fn get_question(&self, principal: &str, task_id: &str) -> Result<ObjectiveQuestion> {
        operator(principal)?;
        name("question Task ID", task_id)?;
        let mut tx = self.pool.begin().await?;
        let question = question_in(&mut tx, task_id, true).await?;
        tx.commit().await?;
        Ok(question)
    }

    pub async fn answer_question(
        &self,
        principal: &str,
        input: &AnswerQuestionRequest,
    ) -> Result<Task> {
        operator(principal)?;
        name("question Task ID", &input.task_id)?;
        name("operation ID", &input.operation_id)?;
        let text = nonempty_text(&input.text, 65_536)?;
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&input.task_id, text))?)
        );
        let (mut tx, order) = self.write().await?;
        if let Some(receipt) = sqlx::query("SELECT request_digest,answer_task_id FROM supertag_v2_question_answers WHERE principal=$1 AND operation_id=$2").bind(principal).bind(&input.operation_id).fetch_optional(&mut *tx).await? {
            if receipt.try_get::<String,_>("request_digest")? != digest { return Err(StoreError::Conflict("operation ID was used with a different answer".into())); }
            let task = task_in(&mut tx, &receipt.try_get::<String,_>("answer_task_id")?).await?;
            tx.rollback().await?;
            return Ok(task);
        }
        let question = question_in(&mut tx, &input.task_id, true).await?;
        if !task_waits_in(&mut tx, &input.task_id).await? {
            return Err(StoreError::FailedPrecondition(
                "question no longer waits for an answer".into(),
            ));
        }
        let source = task_in(&mut tx, &input.task_id).await?;
        objective_admission_in(
            &mut tx,
            &source.tag_id,
            &source.session_id,
            self.execution_now_ms(),
        )
        .await?;
        // Admission may create a limit notice. Recheck the latest-turn condition
        // after it, under the same write lock, before accepting an answer.
        if !task_waits_in(&mut tx, &input.task_id).await? {
            return Err(StoreError::FailedPrecondition(
                "question no longer waits for an answer".into(),
            ));
        }
        let task = insert_task(&mut tx, order, &source.tag_id, &source.session_id, text).await?;
        objective_link_task_in(&mut tx, &task).await?;
        sqlx::query("UPDATE supertag_v2_objective_questions SET answer_task_id=$1 WHERE attempt_id=$2 AND answer_task_id IS NULL").bind(&task.task_id).bind(&question.attempt_id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_question_answers (principal,operation_id,request_digest,question_attempt_id,answer_task_id) VALUES ($1,$2,$3,$4,$5)")
            .bind(principal).bind(&input.operation_id).bind(digest).bind(&question.attempt_id).bind(&task.task_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(task)
    }

    pub async fn list_inbox_items(
        &self,
        principal: &str,
        input: &ListInboxItemsRequest,
    ) -> Result<ListInboxItemsResponse> {
        operator(principal)?;
        if !input.objective_id.is_empty() {
            name("Objective ID", &input.objective_id)?;
        }
        let kind =
            InboxItemKind::try_from(input.kind).map_err(|_| invalid("unknown Inbox kind"))?;
        let scope = format!("{:x}", Sha256::digest(principal.as_bytes()));
        // All Control Plane mutations use this lock. Rolling it back leaves this
        // projection read-only while keeping its component reads consistent.
        let (mut tx, order) = self.write().await?;
        let now = self.execution_now_ms();
        let cursor = if input.cursor.is_empty() {
            Cursor {
                version: 1,
                scope: scope.clone(),
                objective_id: input.objective_id.clone(),
                kind: kind as i32,
                as_of_ms: now,
                upper_order: order - 1,
                at: i64::MIN,
                key: String::new(),
            }
        } else {
            if input.cursor.len() > 4096 {
                return Err(invalid("invalid Inbox cursor"));
            }
            let cursor: Cursor =
                serde_json::from_str(&input.cursor).map_err(|_| invalid("invalid Inbox cursor"))?;
            if cursor.version != 1
                || cursor.scope != scope
                || cursor.as_of_ms > now
                || cursor.upper_order > order - 1
                || cursor.upper_order < 0
                || InboxItemKind::try_from(cursor.kind).is_err()
                || (!input.objective_id.is_empty() && input.objective_id != cursor.objective_id)
                || (kind != InboxItemKind::Unspecified && input.kind != cursor.kind)
            {
                return Err(invalid("Inbox cursor does not match this request"));
            }
            cursor
        };
        let mut items = vec![];
        let mut truncated = vec![];
        if wants(&cursor, InboxItemKind::Question) {
            let rows = sqlx::query("SELECT q.*,o.owner_tag_id FROM supertag_v2_objective_questions q JOIN supertag_v2_tasks t ON t.task_id=q.task_id AND t.attempt_id=q.attempt_id JOIN supertag_v2_objectives o ON o.objective_id=q.objective_id WHERE q.published_at_ms IS NOT NULL AND q.published_at_ms<=$1 AND q.published_order<=$2 AND q.answer_task_id IS NULL AND t.state=$3 AND o.status NOT IN ($4,$5) AND t.tag_id=o.owner_tag_id AND t.session_id=o.session_id AND ($6='' OR q.objective_id=$6) AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks newer WHERE newer.tag_id=t.tag_id AND newer.session_id=t.session_id AND newer.accepted_order>t.accepted_order) ORDER BY q.published_at_ms,q.task_id LIMIT $7")
                .bind(cursor.as_of_ms).bind(cursor.upper_order).bind(TaskState::Succeeded as i64).bind(ObjectiveStatus::Completed as i64).bind(ObjectiveStatus::Cancelled as i64).bind(&cursor.objective_id).bind((SCAN + 1) as i64).fetch_all(&mut *tx).await?;
            if rows.len() > SCAN {
                truncated.push(InboxItemKind::Question as i32);
            }
            for row in rows.iter().take(SCAN) {
                let question = question_row(row)?;
                let key = format!("question:{}", question.task_id);
                let preview: String = question.text.chars().take(PREVIEW).collect();
                items.push(InboxItem {
                    key: key.clone(),
                    occurrence: format!("{key}:{}", question.attempt_id),
                    kind: InboxItemKind::Question as i32,
                    objective_id: question.objective_id,
                    task_id: question.task_id,
                    attempt_id: Some(question.attempt_id),
                    operator_eligible: true,
                    actionable_since_ms: question.published_at_ms.unwrap_or(question.asked_at_ms),
                    reason: "The Objective owner finished a turn and waits for your answer.".into(),
                    question: Some(InboxQuestion {
                        truncated: preview.len() < question.text.len(),
                        text: preview,
                        asked_at_ms: question.asked_at_ms,
                    }),
                    approval: None,
                });
            }
        }
        if wants(&cursor, InboxItemKind::ObjectiveBudget)
            || wants(&cursor, InboxItemKind::ObjectiveLimit)
        {
            let rows = sqlx::query("SELECT * FROM supertag_v2_objectives WHERE status NOT IN ($1,$2) AND created_at_ms<=$3 AND ($4='' OR objective_id=$4) AND EXISTS (SELECT 1 FROM supertag_v2_objective_usage usage WHERE usage.objective_id=supertag_v2_objectives.objective_id) ORDER BY created_at_ms,objective_id LIMIT $5")
                .bind(ObjectiveStatus::Completed as i64).bind(ObjectiveStatus::Cancelled as i64).bind(cursor.as_of_ms).bind(&cursor.objective_id).bind((SCAN + 1) as i64).fetch_all(&mut *tx).await?;
            if rows.len() > SCAN {
                for kind in [
                    InboxItemKind::ObjectiveBudget,
                    InboxItemKind::ObjectiveLimit,
                ] {
                    if wants(&cursor, kind) {
                        truncated.push(kind as i32);
                    }
                }
            }
            for row in rows.iter().take(SCAN) {
                let limits = crate::objectives::inbox_limits_row(row)?;
                for event in limits::limit_events(&limits) {
                    let kind = if event.kind == limits::NoticeKind::ObjectiveBudgetExhausted {
                        InboxItemKind::ObjectiveBudget
                    } else {
                        InboxItemKind::ObjectiveLimit
                    };
                    if !wants(&cursor, kind) || event.at.as_millis() > cursor.as_of_ms {
                        continue;
                    }
                    let objective: String = row.try_get("objective_id")?;
                    let key = format!(
                        "{}:{objective}:{}",
                        if kind == InboxItemKind::ObjectiveBudget {
                            "objective_budget"
                        } else {
                            "objective_limit"
                        },
                        event.key
                    );
                    let reason = if matches!(
                        event.kind,
                        limits::NoticeKind::ObjectiveDeadlineApproaching
                            | limits::NoticeKind::DeadlinePassed
                    ) {
                        deadline_reason(limits.deadline, cursor.as_of_ms)
                    } else {
                        event.message
                    };
                    items.push(InboxItem {
                        key: key.clone(),
                        occurrence: format!("{key}:{}", event.at.as_millis()),
                        kind: kind as i32,
                        objective_id: objective,
                        task_id: String::new(),
                        attempt_id: None,
                        operator_eligible: true,
                        actionable_since_ms: event.at.as_millis(),
                        reason,
                        question: None,
                        approval: None,
                    });
                }
            }
        }
        if wants(&cursor, InboxItemKind::TaskAttention) {
            // Preserve the legacy Objective scope; personal conversation text and
            // another operator's private Sessions never enter this projection.
            let rows = sqlx::query("SELECT t.task_id,t.attempt_id,t.lease_expires_at_ms,t.host_principal,o.objective_id FROM supertag_v2_tasks t JOIN supertag_v2_objective_tasks link ON link.task_id=t.task_id JOIN supertag_v2_objectives o ON o.objective_id=link.objective_id WHERE t.state=$1 AND o.status NOT IN ($2,$3) AND ($4='' OR o.objective_id=$4) AND t.lease_expires_at_ms<=$5 ORDER BY t.lease_expires_at_ms,t.task_id LIMIT $6")
                .bind(TaskState::Uncertain as i64).bind(ObjectiveStatus::Completed as i64).bind(ObjectiveStatus::Cancelled as i64).bind(&cursor.objective_id).bind(cursor.as_of_ms).bind((SCAN + 1) as i64).fetch_all(&mut *tx).await?;
            if rows.len() > SCAN {
                truncated.push(InboxItemKind::TaskAttention as i32);
            }
            for row in rows.iter().take(SCAN) {
                let task_id: String = row.try_get("task_id")?;
                let attempt_id: Option<String> = row.try_get("attempt_id")?;
                let key = format!("task_attention:{task_id}");
                items.push(InboxItem { key: key.clone(), occurrence: format!("{key}:{}", attempt_id.as_deref().unwrap_or("")), kind: InboxItemKind::TaskAttention as i32, objective_id: row.try_get("objective_id")?, task_id, attempt_id, operator_eligible: true, actionable_since_ms: row.try_get("lease_expires_at_ms")?, reason: "Execution is uncertain. Confirm cleanup on the Worker Host before resolving this Attempt.".into(), question: None, approval: None });
            }
        }
        if wants(&cursor, InboxItemKind::Approval) {
            let pending = crate::approvals::pending_in(
                &mut tx,
                principal,
                &cursor.objective_id,
                cursor.as_of_ms,
                cursor.upper_order,
                SCAN + 1,
            )
            .await?;
            if pending.len() > SCAN {
                truncated.push(InboxItemKind::Approval as i32);
            }
            items.extend(pending.into_iter().take(SCAN));
        }
        items.sort_by(|a, b| (a.actionable_since_ms, &a.key).cmp(&(b.actionable_since_ms, &b.key)));
        items.retain(|item| {
            (item.actionable_since_ms, item.key.as_str()) > (cursor.at, cursor.key.as_str())
        });
        let limit = if input.page_size == 0 {
            50
        } else {
            input.page_size.min(100)
        } as usize;
        let more = items.len() > limit;
        items.truncate(limit);
        let next_cursor = if more {
            let last = items.last().expect("nonempty bounded page");
            serde_json::to_string(&Cursor {
                at: last.actionable_since_ms,
                key: last.key.clone(),
                ..cursor
            })?
        } else {
            String::new()
        };
        tx.rollback().await?;
        Ok(ListInboxItemsResponse {
            as_of_ms: cursor.as_of_ms,
            items,
            next_cursor,
            truncated_kinds: truncated,
        })
    }
}

async fn question_objective_in(
    tx: &mut Transaction<'_, Any>,
    task: &AnyRow,
    task_id: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT o.objective_id FROM supertag_v2_objectives o JOIN supertag_v2_objective_tasks link ON link.objective_id=o.objective_id WHERE link.task_id=$1 AND link.kind<>'notice' AND o.owner_tag_id=$2 AND o.session_id=$3 AND o.status NOT IN ($4,$5)")
        .bind(task_id)
        .bind(task.try_get::<String, _>("tag_id")?)
        .bind(task.try_get::<String, _>("session_id")?)
        .bind(ObjectiveStatus::Completed as i64)
        .bind(ObjectiveStatus::Cancelled as i64)
        .fetch_optional(&mut **tx)
        .await?)
}

fn wants(cursor: &Cursor, kind: InboxItemKind) -> bool {
    cursor.kind == 0 || cursor.kind == kind as i32
}
fn deadline_reason(deadline: Option<limits::Timestamp>, now: i64) -> String {
    match deadline {
        Some(deadline) if deadline.as_millis() > now => format!(
            "The Objective deadline is {deadline}; {} seconds remain.",
            (deadline.as_millis() - now) / 1_000
        ),
        Some(deadline) => format!(
            "The Objective deadline {deadline} has passed. New work is refused until an operator changes the limit."
        ),
        None => "The Objective reached a deadline limit.".into(),
    }
}
fn question_row(row: &AnyRow) -> Result<ObjectiveQuestion> {
    Ok(ObjectiveQuestion {
        task_id: row.try_get("task_id")?,
        attempt_id: row.try_get("attempt_id")?,
        objective_id: row.try_get("objective_id")?,
        text: row.try_get("text")?,
        asked_at_ms: row.try_get("asked_at_ms")?,
        published_at_ms: row.try_get("published_at_ms")?,
        answer_task_id: row.try_get("answer_task_id")?,
    })
}
async fn question_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    published: bool,
) -> Result<ObjectiveQuestion> {
    let row = sqlx::query("SELECT q.* FROM supertag_v2_objective_questions q JOIN supertag_v2_tasks t ON t.task_id=q.task_id AND t.attempt_id=q.attempt_id WHERE q.task_id=$1 AND ($2=0 OR q.published_at_ms IS NOT NULL)").bind(task_id).bind(i64::from(published)).fetch_optional(&mut **tx).await?.ok_or_else(|| StoreError::NotFound("published question was not found".into()))?;
    question_row(&row)
}
pub(crate) async fn task_waits_in(tx: &mut Transaction<'_, Any>, task_id: &str) -> Result<bool> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_objective_questions q JOIN supertag_v2_tasks t ON t.task_id=q.task_id AND t.attempt_id=q.attempt_id JOIN supertag_v2_objectives o ON o.objective_id=q.objective_id WHERE q.task_id=$1 AND q.published_at_ms IS NOT NULL AND q.answer_task_id IS NULL AND t.state=$2 AND o.status NOT IN ($3,$4) AND t.tag_id=o.owner_tag_id AND t.session_id=o.session_id AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks newer WHERE newer.tag_id=t.tag_id AND newer.session_id=t.session_id AND newer.accepted_order>t.accepted_order)")
        .bind(task_id).bind(TaskState::Succeeded as i64).bind(ObjectiveStatus::Completed as i64).bind(ObjectiveStatus::Cancelled as i64).fetch_one(&mut **tx).await?;
    Ok(count != 0)
}
pub(crate) async fn finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    signal: i32,
    now: i64,
) -> Result<()> {
    let Some(attempt) = &task.attempt_id else {
        return Ok(());
    };
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT attempt_id FROM supertag_v2_objective_questions WHERE task_id=$1 AND attempt_id=$2",
    )
    .bind(&task.task_id)
    .bind(attempt)
    .fetch_optional(&mut **tx)
    .await?;
    if exists.is_none() {
        return Ok(());
    }
    if signal != ObjectiveSignal::Progress as i32 {
        return Err(invalid(
            "a question cannot be combined with an Objective completion or status signal",
        ));
    }
    if task.state() != TaskState::Succeeded {
        return Ok(());
    }
    sqlx::query("UPDATE supertag_v2_objective_questions SET published_at_ms=$1,published_order=(SELECT revision FROM supertag_v2_write_order WHERE singleton=1) WHERE attempt_id=$2 AND published_at_ms IS NULL")
        .bind(now).bind(attempt).execute(&mut **tx).await?;
    Ok(())
}

impl ControlPlane {
    pub fn inbox_service(&self) -> inbox_server::InboxServer<Self> {
        inbox_server::InboxServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}
#[tonic::async_trait]
impl inbox_server::Inbox for ControlPlane {
    async fn list_items(
        &self,
        request: Request<ListInboxItemsRequest>,
    ) -> std::result::Result<Response<ListInboxItemsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_inbox_items(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get_question(
        &self,
        request: Request<GetQuestionRequest>,
    ) -> std::result::Result<Response<ObjectiveQuestion>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_question(&principal, &request.get_ref().task_id)
                .await?,
        ))
    }
    async fn answer_question(
        &self,
        request: Request<AnswerQuestionRequest>,
    ) -> std::result::Result<Response<Task>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .answer_question(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get_approval(
        &self,
        request: Request<GetApprovalRequest>,
    ) -> std::result::Result<Response<Approval>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_approval(&principal, &request.get_ref().approval_id)
                .await?,
        ))
    }
    async fn list_approvals(
        &self,
        request: Request<ListApprovalsRequest>,
    ) -> std::result::Result<Response<ListApprovalsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_approvals(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn decide_approval(
        &self,
        request: Request<DecideApprovalRequest>,
    ) -> std::result::Result<Response<Approval>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .decide_approval(&principal, request.get_ref())
                .await?,
        ))
    }
}
