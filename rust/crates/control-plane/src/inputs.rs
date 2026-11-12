use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    InspectAttemptRequest, LiveInput, LiveInputDecision, LiveInputReceipt, LiveInputState,
    QueueInputRequest, ResolveInputRequest, SettleInputRequest, TakeInputRequest,
    TakeInputResponse, Task, TaskState,
};
use uuid::Uuid;

use crate::{
    Store, StoreError,
    objectives::{objective_admission_in, objective_link_task_in},
    store::{HostAuthority, Result, insert_task, invalid, lease_is_live, name, owned, text},
};

const ACKNOWLEDGEMENT_MS: i64 = 10_000;

impl Store {
    pub async fn queue_input(
        &self,
        principal: &str,
        request: &QueueInputRequest,
    ) -> Result<LiveInput> {
        validate_operator(principal)?;
        name("Task ID", &request.task_id)?;
        name("operation ID", &request.operation_id)?;
        required_text("live input", &request.text)?;
        let (mut tx, order) = self.write().await?;
        let existing: Option<String> = sqlx::query_scalar("SELECT input_id FROM supertag_v2_live_inputs WHERE operator_principal=$1 AND operation_id=$2")
            .bind(principal).bind(&request.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(id) = existing {
            let (input, _) = input_in(&mut tx, &id).await?;
            if input.task_id != request.task_id || input.text != request.text {
                return Err(StoreError::Conflict(
                    "operation ID was used with different live input".into(),
                ));
            }
            tx.rollback().await?;
            return Ok(input);
        }
        let task = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(&request.task_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
        let now = self.execution_now_ms();
        if !running(&task, now)? {
            return Err(StoreError::FailedPrecondition(
                "live input requires a running Task Attempt".into(),
            ));
        }
        let attempt_id: String = task.try_get("attempt_id")?;
        let tag_id: String = task.try_get("tag_id")?;
        let session_id: String = task.try_get("session_id")?;
        objective_admission_in(&mut tx, &tag_id, &session_id, now).await?;
        let follower = insert_task(&mut tx, order, &tag_id, &session_id, &request.text).await?;
        objective_link_task_in(&mut tx, &follower).await?;
        let input = LiveInput {
            input_id: Uuid::new_v4().to_string(),
            task_id: request.task_id.clone(),
            attempt_id,
            follower_task_id: follower.task_id,
            text: request.text.clone(),
            state: LiveInputState::Pending.into(),
            order: order as u64,
        };
        sqlx::query("INSERT INTO supertag_v2_live_inputs (input_id,operator_principal,operation_id,task_id,attempt_id,follower_task_id,state) VALUES ($1,$2,$3,$4,$5,$6,$7)")
            .bind(&input.input_id).bind(principal).bind(&request.operation_id).bind(&input.task_id)
            .bind(&input.attempt_id).bind(&input.follower_task_id).bind(i64::from(input.state))
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(input)
    }

    pub async fn get_input(&self, input_id: &str) -> Result<LiveInput> {
        name("live input ID", input_id)?;
        let mut tx = self.pool.begin().await?;
        let (input, _) = input_in(&mut tx, input_id).await?;
        tx.commit().await?;
        Ok(input)
    }

    pub async fn take_input(
        &self,
        host: &HostAuthority,
        request: &TakeInputRequest,
    ) -> Result<Option<LiveInput>> {
        Ok(self.take_input_for_host(host, request).await?.input)
    }

    pub async fn take_input_for_host(
        &self,
        host: &HostAuthority,
        request: &TakeInputRequest,
    ) -> Result<TakeInputResponse> {
        let attempt = request
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity required"))?;
        let (mut tx, _) = self.write().await?;
        let task = owned_attempt(&mut tx, host, attempt).await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        if !running(&task, now)? {
            tx.commit().await?;
            return Ok(TakeInputResponse::default());
        }
        let tag_id: String = task.try_get("tag_id")?;
        let session_id: String = task.try_get("session_id")?;
        let id: Option<String> = sqlx::query_scalar(
            "SELECT i.input_id FROM supertag_v2_live_inputs i WHERE i.task_id=$1 AND i.attempt_id=$2 AND i.state=$3
             AND i.follower_task_id=(SELECT task_id FROM supertag_v2_tasks WHERE tag_id=$4 AND session_id=$5 AND state=$6 ORDER BY accepted_order LIMIT 1)
             AND NOT EXISTS (SELECT 1 FROM supertag_v2_live_inputs prior JOIN supertag_v2_tasks f ON f.task_id=prior.follower_task_id WHERE f.tag_id=$4 AND f.session_id=$5 AND prior.state IN ($7,$8))",
        )
        .bind(&attempt.task_id).bind(&attempt.attempt_id).bind(LiveInputState::Pending as i64)
        .bind(tag_id).bind(session_id).bind(TaskState::Queued as i64)
        .bind(LiveInputState::Dispatching as i64).bind(LiveInputState::Unknown as i64)
        .fetch_optional(&mut *tx).await?;
        let response = if let Some(id) = id {
            let lease_end: i64 = task.try_get("lease_expires_at_ms")?;
            let valid_for_ms = lease_end.saturating_sub(now).min(ACKNOWLEDGEMENT_MS) as u64;
            sqlx::query("UPDATE supertag_v2_live_inputs SET state=$1,acknowledgement_deadline_ms=$2 WHERE input_id=$3")
                .bind(LiveInputState::Dispatching as i64).bind(now.saturating_add(ACKNOWLEDGEMENT_MS))
                .bind(&id).execute(&mut *tx).await?;
            TakeInputResponse {
                input: Some(input_in(&mut tx, &id).await?.0),
                valid_for_ms,
            }
        } else {
            TakeInputResponse::default()
        };
        // A lost response is uncertain. No later take returns this text again.
        tx.commit().await?;
        Ok(response)
    }

    pub async fn settle_input(
        &self,
        host: &HostAuthority,
        request: &SettleInputRequest,
    ) -> Result<LiveInput> {
        name("live input ID", &request.input_id)?;
        let attempt = request
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity required"))?;
        let next = match request.receipt() {
            LiveInputReceipt::Accepted => LiveInputState::Accepted,
            LiveInputReceipt::Rejected => LiveInputState::Rejected,
            LiveInputReceipt::Unknown => LiveInputState::Unknown,
            LiveInputReceipt::Withdrawn => LiveInputState::Withdrawn,
            LiveInputReceipt::Unspecified => return Err(invalid("live input receipt is required")),
        };
        let (mut tx, _) = self.write().await?;
        owned_attempt(&mut tx, host, attempt).await?;
        sweep_in(&mut tx, self.execution_now_ms()).await?;
        let (mut input, _) = input_in(&mut tx, &request.input_id).await?;
        if input.task_id != attempt.task_id || input.attempt_id != attempt.attempt_id {
            return Err(StoreError::PermissionDenied);
        }
        let current = input.state();
        if current == next || current == LiveInputState::Withdrawn {
            // A withdrawal can arrive before the acknowledgement. The withdrawal
            // proves the input was unread and stays authoritative.
            tx.commit().await?;
            return Ok(input);
        }
        let withdrawal = next == LiveInputState::Withdrawn
            && matches!(current, LiveInputState::Accepted | LiveInputState::Unknown);
        if current != LiveInputState::Dispatching && !withdrawal {
            tx.commit().await?;
            return Err(StoreError::FailedPrecondition(
                "live input receipt cannot change the recorded delivery".into(),
            ));
        }
        match next {
            LiveInputState::Accepted => {
                let result = format!("Input accepted by Task {}.", input.task_id);
                update_follower(
                    &mut tx,
                    &input.follower_task_id,
                    TaskState::Queued,
                    TaskState::Succeeded,
                    Some(&result),
                )
                .await?;
            }
            LiveInputState::Withdrawn if current == LiveInputState::Accepted => {
                update_follower(
                    &mut tx,
                    &input.follower_task_id,
                    TaskState::Succeeded,
                    TaskState::Queued,
                    None,
                )
                .await?;
            }
            _ => {}
        }
        set_state(&mut tx, &mut input, next).await?;
        tx.commit().await?;
        Ok(input)
    }

    pub async fn resolve_input(
        &self,
        principal: &str,
        request: &ResolveInputRequest,
    ) -> Result<LiveInput> {
        validate_operator(principal)?;
        name("live input ID", &request.input_id)?;
        name("operation ID", &request.operation_id)?;
        required_text("live input recovery evidence", &request.evidence)?;
        let next = match request.decision() {
            LiveInputDecision::Fail => LiveInputState::Failed,
            LiveInputDecision::Retry => LiveInputState::Retried,
            LiveInputDecision::Unspecified => {
                return Err(invalid("live input recovery decision is required"));
            }
        };
        let (mut tx, _) = self.write().await?;
        let replay = sqlx::query("SELECT input_id,decision,evidence FROM supertag_v2_live_input_resolutions WHERE operator_principal=$1 AND operation_id=$2")
            .bind(principal).bind(&request.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(replay) = replay {
            if replay.try_get::<String, _>("input_id")? != request.input_id
                || replay.try_get::<i64, _>("decision")? != i64::from(request.decision)
                || replay.try_get::<String, _>("evidence")? != request.evidence
            {
                return Err(StoreError::Conflict(
                    "operation ID was used with different live input recovery evidence".into(),
                ));
            }
            let input = input_in(&mut tx, &request.input_id).await?.0;
            tx.rollback().await?;
            return Ok(input);
        }
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let (mut input, follower_state) = input_in(&mut tx, &request.input_id).await?;
        if input.state() != LiveInputState::Unknown {
            return Err(StoreError::FailedPrecondition(
                "only uncertain live input can be resolved".into(),
            ));
        }
        if next == LiveInputState::Retried && follower_state != TaskState::Queued as i64 {
            return Err(StoreError::FailedPrecondition(
                "live input fallback Task is no longer queued".into(),
            ));
        }
        if next == LiveInputState::Failed {
            update_follower(
                &mut tx,
                &input.follower_task_id,
                TaskState::Queued,
                TaskState::Failed,
                Some("Uncertain live input delivery was closed by an operator."),
            )
            .await?;
        }
        sqlx::query("INSERT INTO supertag_v2_live_input_resolutions (input_id,operator_principal,operation_id,decision,evidence,resolved_at_ms) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(&input.input_id).bind(principal).bind(&request.operation_id)
            .bind(i64::from(request.decision)).bind(&request.evidence).bind(now)
            .execute(&mut *tx).await?;
        set_state(&mut tx, &mut input, next).await?;
        tx.commit().await?;
        Ok(input)
    }

    pub async fn sweep_inputs(&self) -> Result<u64> {
        let (mut tx, _) = self.write().await?;
        let changed = sweep_in(&mut tx, self.execution_now_ms()).await?;
        if changed == 0 {
            tx.rollback().await?;
        } else {
            tx.commit().await?;
        }
        Ok(changed)
    }
}

pub(crate) async fn sweep_in(tx: &mut Transaction<'_, Any>, now: i64) -> Result<u64> {
    // The target can finish while a valid acknowledgement is in flight.
    // Preserve the dispatch hold until that receipt arrives or its window ends.
    let unknown = sqlx::query("UPDATE supertag_v2_live_inputs SET state=$1 WHERE state=$2 AND acknowledgement_deadline_ms <= $3")
        .bind(LiveInputState::Unknown as i64).bind(LiveInputState::Dispatching as i64).bind(now)
        .execute(&mut **tx).await?.rows_affected();
    // A pending input was never taken. It can fall back to its ordinary queued
    // Task when the original attempt can no longer receive it.
    let rejected = sqlx::query(
        "UPDATE supertag_v2_live_inputs AS i SET state=$1 WHERE i.state=$2
         AND (NOT EXISTS (SELECT 1 FROM supertag_v2_tasks t WHERE t.task_id=i.task_id AND t.attempt_id=i.attempt_id AND t.state=$3 AND t.lease_expires_at_ms > $4)
         OR NOT EXISTS (SELECT 1 FROM supertag_v2_tasks f WHERE f.task_id=i.follower_task_id AND f.state=$5))",
    )
    .bind(LiveInputState::Rejected as i64).bind(LiveInputState::Pending as i64)
    .bind(TaskState::Running as i64).bind(now).bind(TaskState::Queued as i64)
    .execute(&mut **tx).await?.rows_affected();
    Ok(unknown + rejected)
}

pub(crate) async fn can_claim_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    order: i64,
) -> Result<bool> {
    let blocked: Option<String> = sqlx::query_scalar(
        "SELECT i.input_id FROM supertag_v2_live_inputs i JOIN supertag_v2_tasks f ON f.task_id=i.follower_task_id
         WHERE f.tag_id=$1 AND f.session_id=$2 AND f.accepted_order <= $3 AND i.state IN ($4,$5) LIMIT 1",
    )
    .bind(&task.tag_id).bind(&task.session_id).bind(order)
    .bind(LiveInputState::Dispatching as i64).bind(LiveInputState::Unknown as i64)
    .fetch_optional(&mut **tx).await?;
    Ok(blocked.is_none())
}

async fn input_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<(LiveInput, i64)> {
    let row = sqlx::query(
        "SELECT i.*,f.prompt AS input_text,f.accepted_order AS input_order,f.state AS follower_state
         FROM supertag_v2_live_inputs i JOIN supertag_v2_tasks f ON f.task_id=i.follower_task_id WHERE i.input_id=$1",
    )
    .bind(id).fetch_optional(&mut **tx).await?
    .ok_or_else(|| StoreError::NotFound("live input was not found".into()))?;
    Ok((
        LiveInput {
            input_id: row.try_get("input_id")?,
            task_id: row.try_get("task_id")?,
            attempt_id: row.try_get("attempt_id")?,
            follower_task_id: row.try_get("follower_task_id")?,
            text: row.try_get("input_text")?,
            state: row.try_get::<i64, _>("state")? as i32,
            order: row.try_get::<i64, _>("input_order")? as u64,
        },
        row.try_get("follower_state")?,
    ))
}

async fn owned_attempt(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
) -> Result<AnyRow> {
    owned(
        tx,
        host,
        &attempt.task_id,
        &attempt.attempt_id,
        &attempt.lease_token,
    )
    .await
}

async fn update_follower(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    current: TaskState,
    next: TaskState,
    result: Option<&str>,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,result=$2 WHERE task_id=$3 AND state=$4 AND attempt_id IS NULL")
        .bind(next as i64).bind(result).bind(task_id).bind(current as i64)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn set_state(
    tx: &mut Transaction<'_, Any>,
    input: &mut LiveInput,
    state: LiveInputState,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_live_inputs SET state=$1 WHERE input_id=$2")
        .bind(state as i64)
        .bind(&input.input_id)
        .execute(&mut **tx)
        .await?;
    input.state = state.into();
    Ok(())
}

fn running(task: &AnyRow, now: i64) -> Result<bool> {
    Ok(task.try_get::<i64, _>("state")? == TaskState::Running as i64 && lease_is_live(task, now)?)
}

fn validate_operator(principal: &str) -> Result<()> {
    let operator = principal
        .strip_prefix("operator:")
        .ok_or(StoreError::PermissionDenied)?;
    name("operator identity", operator)
}

fn required_text(kind: &str, value: &str) -> Result<()> {
    text(kind, value, 16_384)?;
    if value.trim().is_empty() {
        return Err(invalid(&format!("{kind} is required")));
    }
    Ok(())
}
