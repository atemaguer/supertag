//! Work started by an owned Attempt and kept in a separate Session.
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
    store::{Result, insert_task_from_snapshot, invalid, lease_is_live, name, owned, task_row},
};

pub(crate) const CHILD: i64 = 1;
pub(crate) const REPORT: i64 = 2;
const MAX_PER_TURN: i64 = 4;
const MAX_OPEN: i64 = 8;
const MAX_RUNNING: i64 = 4;
const SESSION_PREFIX: &str = "work/";

pub(crate) fn reserved_session(session_id: &str) -> bool {
    session_id.starts_with(SESSION_PREFIX)
}

pub(crate) async fn task_kind_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<Option<i64>> {
    Ok(
        sqlx::query_scalar("SELECT kind FROM supertag_v2_work_session_tasks WHERE task_id=$1")
            .bind(task_id)
            .fetch_optional(&mut **tx)
            .await?,
    )
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

impl Store {
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
        if reserved_session(&parent.session_id)
            || crate::mailbox::private_session(&parent.session_id)
            || task_kind_in(&mut tx, &parent.task_id).await?.is_some()
        {
            return Err(StoreError::PermissionDenied);
        }
        let target = input.target_tag_id.as_deref().unwrap_or(&parent.tag_id);
        if target != parent.tag_id {
            return Err(StoreError::PermissionDenied);
        }
        let workspace = parent
            .workspace
            .as_ref()
            .map(|spec| spec.workspace_id.as_str());
        if input
            .workspace_id
            .as_deref()
            .is_some_and(|requested| Some(requested) != workspace)
        {
            return Err(StoreError::FailedPrecondition(
                "Workspace differs from the accepted parent Task".into(),
            ));
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &title,
                instruction,
                workspace,
                target
            ))?)
        );
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
        let id = format!("{SESSION_PREFIX}{}", Uuid::new_v4());
        let prompt = format!(
            "Complete the following Work Session assignment. Return the result for the parent Session. If you need an answer to proceed, call ask with a text argument containing one question, then end this turn.\n\n{}",
            serde_json::json!({ "title": title, "instruction": instruction }),
        );
        let child = insert_task_from_snapshot(&mut tx, order, &parent, &id, &prompt).await?;
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
}
