use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    AttemptAuthority, AttemptDecision, AttemptExecutionSelection, AttemptResolution,
    HarnessExecutionProfile, HarnessKind, InspectAttemptRequest, ResolveAttemptRequest, Task,
    TaskState,
};

use super::{
    HostAuthority, Result, Store, StoreError, execution, hosts::current_scope_in, invalid, name,
    owned, task_in, task_row, text,
};

const LEASE_MS: i64 = 30_000;

impl Store {
    /// Supply the Control Plane's clock for deterministic state transition tests.
    pub fn with_execution_clock(mut self, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        self.execution_clock = Some(Arc::new(clock));
        self
    }

    pub(crate) fn execution_now_ms(&self) -> i64 {
        self.execution_clock
            .as_ref()
            .map_or_else(system_now_ms, |clock| clock())
    }

    pub async fn sweep_expired_attempts(&self) -> Result<u64> {
        let (mut transaction, _) = self.write().await?;
        let changed = expire_due_attempts(&mut transaction, self.execution_now_ms()).await?;
        if changed > 0 {
            transaction.commit().await?;
        } else {
            transaction.rollback().await?;
        }
        Ok(changed)
    }

    pub async fn renew_attempt(
        &self,
        host: &HostAuthority,
        input: &InspectAttemptRequest,
    ) -> Result<AttemptAuthority> {
        let (mut transaction, _) = self.write().await?;
        let now = self.execution_now_ms();
        // A due Objective stop is a cancellation, even when its capped lease
        // expires at the same instant. Preserve its normal cleanup receipt path.
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        let row = owned(
            &mut transaction,
            host,
            &input.task_id,
            &input.attempt_id,
            &input.lease_token,
        )
        .await?;
        let task = task_row(&row)?;
        let mut valid_for_ms = 0;
        if task.state() == TaskState::Running {
            if lease_is_live(&row, now)? {
                let deadline = crate::objectives::objective_lease_deadline_in(
                    &mut transaction,
                    &task,
                    lease_deadline(now),
                )
                .await?;
                sqlx::query(
                    "UPDATE supertag_v2_tasks SET lease_expires_at_ms = $1 WHERE task_id = $2",
                )
                .bind(deadline)
                .bind(&input.task_id)
                .execute(&mut *transaction)
                .await?;
                valid_for_ms = (deadline - now) as u64;
            } else {
                mark_uncertain(&mut transaction, &input.task_id).await?;
            }
        }
        let task = task_in(&mut transaction, &input.task_id).await?;
        transaction.commit().await?;
        Ok(AttemptAuthority {
            task: Some(task),
            valid_for_ms,
        })
    }

    pub async fn resolve_attempt(
        &self,
        principal: &str,
        input: &ResolveAttemptRequest,
    ) -> Result<AttemptResolution> {
        name("principal", principal)?;
        let operator_id = principal
            .strip_prefix("operator:")
            .ok_or(StoreError::PermissionDenied)?;
        name("operator ID", operator_id)?;
        name("Task ID", &input.task_id)?;
        name("Task Attempt ID", &input.attempt_id)?;
        name("operation ID", &input.operation_id)?;
        text("recovery evidence", &input.evidence, 16_384)?;
        if input.evidence.trim().is_empty() {
            return Err(invalid("recovery evidence is required"));
        }
        let decision = AttemptDecision::try_from(input.decision)
            .map_err(|_| invalid("invalid recovery decision"))?;
        if !matches!(decision, AttemptDecision::Failed | AttemptDecision::Retry) {
            return Err(invalid("recovery decision is required"));
        }
        let (mut transaction, _) = self.write().await?;
        let now = self.execution_now_ms();
        let replay = sqlx::query("SELECT * FROM supertag_v2_attempt_resolutions WHERE operator_principal = $1 AND operation_id = $2")
            .bind(principal).bind(&input.operation_id).fetch_optional(&mut *transaction).await?;
        if let Some(replay) = replay {
            let resolution = resolution_row(&replay)?;
            if resolution.task_id != input.task_id
                || resolution.attempt_id != input.attempt_id
                || resolution.decision != input.decision
                || resolution.evidence != input.evidence
                || replay.try_get::<i64, _>("confirmed_stopped")?
                    != i64::from(input.confirmed_stopped)
            {
                return Err(StoreError::Conflict(
                    "operation ID was used with different recovery evidence".into(),
                ));
            }
            transaction.rollback().await?;
            return Ok(resolution);
        }
        let already_resolved: Option<String> = sqlx::query_scalar(
            "SELECT attempt_id FROM supertag_v2_attempt_resolutions WHERE attempt_id = $1",
        )
        .bind(&input.attempt_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if already_resolved.is_some() {
            return Err(StoreError::Conflict(
                "Task Attempt already has a recovery decision".into(),
            ));
        }

        // Persist Objective observations while the old Attempt identity is still
        // current, and apply any cancellation that was already due.
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
            .bind(&input.task_id)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
        let task = task_row(&row)?;
        if task.attempt_id.as_deref() != Some(input.attempt_id.as_str()) {
            return Err(StoreError::FailedPrecondition(
                "Task Attempt no longer owns this Task".into(),
            ));
        }
        let cancelled = task.state() == TaskState::Cancelled;
        let expired = !lease_is_live(&row, now)?;
        let may_have_run = matches!(task.state(), TaskState::Running | TaskState::Cancelled)
            && row.try_get::<i64, _>("cleanup_pending")? == 1;
        if task.state() != TaskState::Uncertain && !(expired && may_have_run) {
            return Err(StoreError::FailedPrecondition(
                "Task Attempt does not require recovery".into(),
            ));
        }
        if cancelled && decision == AttemptDecision::Retry {
            return Err(StoreError::FailedPrecondition(
                "cancelled Task cannot be retried by recovery".into(),
            ));
        }
        if !input.confirmed_stopped && row.try_get::<i64, _>("cleanup_observed")? != 1 {
            return Err(StoreError::FailedPrecondition(
                "execution cleanup must be confirmed before recovery".into(),
            ));
        }

        sqlx::query("INSERT INTO supertag_v2_attempt_resolutions (attempt_id, task_id, operator_principal, operation_id, decision, evidence, confirmed_stopped, resolved_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(&input.attempt_id).bind(&input.task_id).bind(principal).bind(&input.operation_id)
            .bind(i64::from(input.decision)).bind(&input.evidence).bind(i64::from(input.confirmed_stopped))
            .bind(now).execute(&mut *transaction).await?;
        if decision == AttemptDecision::Retry {
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1, result = NULL, attempt_id = NULL, host_principal = NULL, host_generation = NULL, lease_token = NULL, lease_expires_at_ms = NULL, cleanup_pending = 0, cleanup_observed = 0, event_sequence_base = 0, finish_objective_signal = 0 WHERE task_id = $2")
                .bind(TaskState::Queued as i64).bind(&input.task_id).execute(&mut *transaction).await?;
        } else {
            let state = if cancelled {
                TaskState::Cancelled
            } else {
                TaskState::Failed
            };
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1, cleanup_pending = 0, cleanup_observed = 1 WHERE task_id = $2")
                .bind(state as i64).bind(&input.task_id).execute(&mut *transaction).await?;
        }
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        transaction.commit().await?;
        Ok(AttemptResolution {
            task_id: input.task_id.clone(),
            attempt_id: input.attempt_id.clone(),
            decision: input.decision,
            operator_id: operator_id.into(),
            evidence: input.evidence.clone(),
            resolved_at_ms: now,
        })
    }

    pub async fn get_attempt_resolution(
        &self,
        host: &HostAuthority,
        input: &InspectAttemptRequest,
    ) -> Result<Option<AttemptResolution>> {
        name("Task ID", &input.task_id)?;
        name("Task Attempt ID", &input.attempt_id)?;
        name("lease token", &input.lease_token)?;
        let mut transaction = self.pool.begin().await?;
        current_scope_in(&mut transaction, host).await?;
        // The claim retains the original token and principal even after an explicit
        // retry replaces the Task's current owner. This read grants no execution rights.
        let owner: Option<String> = sqlx::query_scalar("SELECT attempt_id FROM supertag_v2_claims WHERE task_id = $1 AND attempt_id = $2 AND principal = $3 AND lease_token = $4")
            .bind(&input.task_id).bind(&input.attempt_id).bind(&host.principal).bind(&input.lease_token)
            .fetch_optional(&mut *transaction).await?;
        if owner.is_none() {
            return Err(StoreError::PermissionDenied);
        }
        let resolution = sqlx::query(
            "SELECT * FROM supertag_v2_attempt_resolutions WHERE task_id = $1 AND attempt_id = $2",
        )
        .bind(&input.task_id)
        .bind(&input.attempt_id)
        .fetch_optional(&mut *transaction)
        .await?
        .as_ref()
        .map(resolution_row)
        .transpose()?;
        transaction.commit().await?;
        Ok(resolution)
    }
}

pub(super) fn lease_deadline(now: i64) -> i64 {
    now.saturating_add(LEASE_MS)
}

pub(crate) fn lease_is_live(row: &AnyRow, now: i64) -> Result<bool> {
    Ok(row
        .try_get::<Option<i64>, _>("lease_expires_at_ms")?
        .is_some_and(|deadline| now < deadline))
}

fn supports_execution_limits(harness: HarnessKind, task: &Task) -> bool {
    let Some(limits) = &task.execution_limits else {
        return true;
    };
    match harness {
        // Custom Harnesses confirm the applied limits on the local bridge before running.
        HarnessKind::Unspecified => true,
        HarnessKind::Codex => {
            limits.max_reported_cost.is_none()
                && limits.max_native_agents.is_none_or(|limit| limit == 0)
        }
        HarnessKind::ClaudeCode => {
            limits.max_reported_tokens.is_none()
                && limits.max_native_agents.is_none()
                && limits
                    .max_reported_cost
                    .as_ref()
                    .is_none_or(|limit| limit.currency == "USD")
        }
        HarnessKind::OpenaiAgents | HarnessKind::Opencode | HarnessKind::Cursor => false,
    }
}

// Cursor's local SDK bridge exposes only these scoped tools. Keep work requiring
// another native capability queued instead of claiming it and weakening policy.
fn supports_runtime_actions(harness: HarnessKind, task: &Task) -> bool {
    harness != HarnessKind::Cursor
        || (task.allowed_actions.iter().all(|action| {
            matches!(
                action.as_str(),
                "files:read"
                    | "files:write"
                    | "commands:execute"
                    | "web:search"
                    | "workstream:post"
                    | "mailbox:send"
            )
        }) && (!task.allowed_actions.iter().any(|a| a == "commands:execute")
            || task.allowed_actions.iter().any(|a| a == "files:write")))
}

pub(super) async fn claim_candidate(
    transaction: &mut Transaction<'_, Any>,
    now: i64,
    host_id: &str,
    all_tags: i64,
    (workspace_ids, gateway_workspace_ids): (&[String], &[String]),
    (harness, profile): (HarnessKind, &HarnessExecutionProfile),
    context_contracts: &[supertag_protocol::v2::ContextContract],
) -> Result<Option<(String, AttemptExecutionSelection)>> {
    let context_contracts = if matches!(
        harness,
        HarnessKind::Opencode | HarnessKind::OpenaiAgents | HarnessKind::Cursor
    ) {
        &[]
    } else {
        context_contracts
    };
    let mut after = 0_i64;
    loop {
        let candidates = sqlx::query("SELECT pending.task_id, pending.accepted_order FROM supertag_v2_tasks pending WHERE pending.state = $1 AND pending.accepted_order > $2 AND pending.harness_kind IN (0,$8) AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks active WHERE active.tag_id = pending.tag_id AND active.session_id = pending.session_id AND (active.state IN ($3,$4,$5) OR active.cleanup_pending = 1)) AND ($6 = 1 OR EXISTS (SELECT 1 FROM supertag_v2_host_tags scope WHERE scope.host_id=$7 AND scope.tag_id=pending.tag_id)) ORDER BY pending.accepted_order LIMIT 32")
            .bind(TaskState::Queued as i64).bind(after).bind(TaskState::Claimed as i64)
            .bind(TaskState::Running as i64).bind(TaskState::Uncertain as i64).bind(all_tags).bind(host_id).bind(harness as i64)
            .fetch_all(&mut **transaction).await?;
        let last_page = candidates.len() < 32;
        for candidate in candidates {
            let id: String = candidate.try_get("task_id")?;
            let task = task_in(transaction, &id).await?;
            let has_workspace = task.workspace.as_ref().is_none_or(|spec| {
                let sources = if spec.github_source.is_some() {
                    gateway_workspace_ids
                } else {
                    workspace_ids
                };
                sources.binary_search(&spec.workspace_id).is_ok()
            });
            if let Some(attempt_execution) = execution::resolve_attempt(&task, harness, profile)
                && has_workspace
                && task
                    .workspace
                    .as_ref()
                    .is_none_or(|spec| supertag_protocol::valid_git_commit(&spec.base_commit))
                && supports_execution_limits(harness, &task)
                && supports_runtime_actions(harness, &task)
                && crate::context::task_supported(&task, context_contracts)
                && crate::work_sessions::can_claim_in(transaction, &task).await?
                && crate::inputs::can_claim_in(
                    transaction,
                    &task,
                    candidate.try_get("accepted_order")?,
                )
                .await?
                && crate::objectives::objective_task_can_start_in(transaction, &task, now).await?
            {
                return Ok(Some((id, attempt_execution)));
            }
            after = candidate.try_get("accepted_order")?;
        }
        if last_page {
            return Ok(None);
        }
    }
}

pub(super) async fn expire_due_attempts(
    transaction: &mut Transaction<'_, Any>,
    now: i64,
) -> Result<u64> {
    let claims = sqlx::query("UPDATE supertag_v2_tasks SET state = $1, attempt_id = NULL, host_principal = NULL, host_generation = NULL, lease_token = NULL, lease_expires_at_ms = NULL, event_sequence_base = 0 WHERE state = $2 AND lease_expires_at_ms <= $3")
        .bind(TaskState::Queued as i64).bind(TaskState::Claimed as i64).bind(now)
        .execute(&mut **transaction).await?.rows_affected();
    let running = sqlx::query("UPDATE supertag_v2_tasks SET state = $1, cleanup_pending = 1 WHERE state = $2 AND lease_expires_at_ms <= $3")
        .bind(TaskState::Uncertain as i64).bind(TaskState::Running as i64).bind(now)
        .execute(&mut **transaction).await?.rows_affected();
    Ok(claims + running)
}

pub(super) async fn mark_uncertain(
    transaction: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_tasks SET state = $1, cleanup_pending = 1 WHERE task_id = $2")
        .bind(TaskState::Uncertain as i64)
        .bind(task_id)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn resolution_row(row: &AnyRow) -> Result<AttemptResolution> {
    let principal: String = row.try_get("operator_principal")?;
    let operator_id = principal
        .strip_prefix("operator:")
        .ok_or(StoreError::PermissionDenied)?;
    Ok(AttemptResolution {
        task_id: row.try_get("task_id")?,
        attempt_id: row.try_get("attempt_id")?,
        decision: row.try_get::<i64, _>("decision")? as i32,
        operator_id: operator_id.into(),
        evidence: row.try_get("evidence")?,
        resolved_at_ms: row.try_get("resolved_at_ms")?,
    })
}
