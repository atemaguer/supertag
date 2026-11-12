//! A child can ask one question. Successful settlement publishes it to the parent.
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    AskWorkSessionQuestionRequest, FinishTaskRequest, ObjectiveSignal, Task, TaskState,
    WorkSessionQuestion,
};

use crate::{
    HostAuthority, Store, StoreError,
    store::{Result, invalid, lease_is_live, name, owned},
    work_sessions::CHILD,
};

const QUESTION_MAX: usize = 2_000;

fn question_row(row: &AnyRow) -> Result<WorkSessionQuestion> {
    Ok(WorkSessionQuestion {
        work_session_id: row.try_get("work_session_id")?,
        task_id: row.try_get("task_id")?,
        attempt_id: row.try_get("attempt_id")?,
        text: row.try_get("text")?,
        asked_at_ms: row.try_get("asked_at_ms")?,
        published_at_ms: row.try_get("published_at_ms")?,
        answer_task_id: row.try_get("answer_task_id")?,
    })
}

impl Store {
    pub async fn ask_work_session_question(
        &self,
        host: &HostAuthority,
        input: &AskWorkSessionQuestionRequest,
    ) -> Result<WorkSessionQuestion> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        name("operation ID", &input.operation_id)?;
        let text = input.text.trim();
        if text.is_empty() || text.contains('\0') || text.encode_utf16().count() > QUESTION_MAX {
            return Err(invalid(
                "Work Session question must contain 1–2,000 characters",
            ));
        }
        let (mut tx, _) = self.write().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let session: String = sqlx::query_scalar(
            "SELECT work_session_id FROM supertag_v2_work_session_tasks WHERE task_id=$1 AND kind=$2",
        )
        .bind(&attempt.task_id)
        .bind(CHILD)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::PermissionDenied)?;
        if let Some(row) = sqlx::query(
            "SELECT * FROM supertag_v2_work_session_questions WHERE attempt_id=$1 AND task_id=$2",
        )
        .bind(&attempt.attempt_id)
        .bind(&attempt.task_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            if row.try_get::<String, _>("operation_id")? != input.operation_id
                || row.try_get::<String, _>("text")? != text
            {
                return Err(StoreError::Conflict(
                    "this Attempt already asked a different Work Session question".into(),
                ));
            }
            let result = question_row(&row)?;
            tx.rollback().await?;
            return Ok(result);
        }
        let now = self.execution_now_ms();
        if task.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&task, now)?
        {
            return Err(StoreError::FailedPrecondition(
                "a Work Session question requires a live running Attempt".into(),
            ));
        }
        crate::mcp_effects::require_no_pending_approval_in(&mut tx, &attempt.attempt_id).await?;
        let row = sqlx::query(
            "INSERT INTO supertag_v2_work_session_questions
             (attempt_id,task_id,work_session_id,operation_id,text,asked_at_ms)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        )
        .bind(&attempt.attempt_id)
        .bind(&attempt.task_id)
        .bind(&session)
        .bind(&input.operation_id)
        .bind(text)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
        let result = question_row(&row)?;
        tx.commit().await?;
        Ok(result)
    }
}

pub(crate) async fn finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: &FinishTaskRequest,
    now: i64,
) -> Result<()> {
    if task.state() != TaskState::Succeeded {
        return Ok(());
    }
    let question: Option<String> = sqlx::query_scalar(
        "SELECT attempt_id FROM supertag_v2_work_session_questions
         WHERE task_id=$1 AND attempt_id=$2",
    )
    .bind(&task.task_id)
    .bind(&input.attempt_id)
    .fetch_optional(&mut **tx)
    .await?;
    if question.is_none() {
        return Ok(());
    }
    if input.objective_signal != ObjectiveSignal::Progress as i32
        || !input.waiting_approval_ids.is_empty()
    {
        return Err(invalid(
            "a Work Session question requires a Progress outcome without an approval wait",
        ));
    }
    sqlx::query(
        "UPDATE supertag_v2_work_session_questions SET published_at_ms=$1
         WHERE task_id=$2 AND attempt_id=$3 AND published_at_ms IS NULL",
    )
    .bind(now)
    .bind(&task.task_id)
    .bind(&input.attempt_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(crate) async fn continued_in(
    tx: &mut Transaction<'_, Any>,
    previous_child_task_id: &str,
    new_child_task_id: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE supertag_v2_work_session_questions SET answer_task_id=$2
         WHERE task_id=$1 AND published_at_ms IS NOT NULL AND answer_task_id IS NULL
         AND attempt_id=(SELECT attempt_id FROM supertag_v2_tasks WHERE task_id=$1)",
    )
    .bind(previous_child_task_id)
    .bind(new_child_task_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
