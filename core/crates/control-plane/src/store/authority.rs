use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use prost::Message;
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    AttemptAuthority, AttemptDecision, AttemptExecutionSelection, AttemptResolution,
    HarnessExecutionProfile, HarnessKind, InspectAttemptRequest, ReclaimAttemptRequest,
    ReportAppliedLimitsRequest, ResolveAttemptRequest, Task, TaskState,
};

use super::{
    HostAuthority, Result, Store, StoreError, execution, hosts::current_scope_in, invalid, name,
    owned, task_in, task_row, text,
};

const LEASE_MS: i64 = 30_000;
/// The most Task Attempts a Task gets when its Attempts are interrupted: two redeliveries.
pub(crate) const MAX_TASK_ATTEMPTS: i64 = 3;
/// How long a redelivered Task waits before it can be claimed: after its first interrupted
/// Attempt, then after its second.
const REDELIVERY_BACKOFF_MS: [i64; 2] = [5_000, 30_000];
/// At most this many of the interrupted runs' messages, and this many bytes of them, go into a
/// redelivered Attempt's prompt: the most recent.
const ALREADY_SAID_MESSAGES: i64 = 20;
const ALREADY_SAID_BYTES: usize = 32 * 1024;
/// How long the operator Inbox shows a Task that was not redelivered.
pub(crate) const NOT_REDELIVERED_SHOWN_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// How long after an uncertain Task Attempt's lease lapsed SuperTag waits before it records one
/// as failed on its own (see [`settle_stopped_uncertain_in`]).
pub(crate) const AUTO_RESOLVE_GRACE_MS: i64 = 60_000;
/// Who an automatic decision is recorded as, in the decision and in the audit log.
pub(crate) const AUTOMATIC_PRINCIPAL: &str = "control-plane";
/// The result of a Task whose uncertain Attempt SuperTag recorded as failed on its own.
const AUTO_FAILED_RESULT: &str = "Execution was interrupted before SuperTag heard how it ended, so the outcome is unknown. Its Worker Host confirmed it stopped, and it had sent no reply or message, delivered no changes, and published nothing, so SuperTag recorded it as failed and let the Session's next turn run. Anything it changed outside SuperTag, such as files or commands, is not undone. Send the request again to run it.";

/// The result a reclaimed Attempt's Task records when it is not redelivered and has none, as
/// TypeScript's `InterruptedExecutionOutcomeUnknown` failure says, with why it was not retried.
fn reclaimed_result(reason: &str) -> String {
    format!(
        "Execution was interrupted before the harness finished. The host confirmed that every process it started for this Attempt is gone. The outcome is unknown, and SuperTag did not run the Task again because {reason}."
    )
}

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
        let _wake = self.hint_after_commit();
        let (mut transaction, _) = self.write().await?;
        let now = self.execution_now_ms();
        let changed = expire_due_attempts(&mut transaction, now).await?
            + settle_stopped_uncertain_in(&mut transaction, now).await?;
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
        let mut task = task_in(&mut transaction, &input.task_id).await?;
        // The Worker Host commits the Task's work as the Tag, with the requester as co-author.
        crate::workspace_landings::with_author_in(&mut transaction, &mut task).await?;
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
        let _wake = self.hint_after_commit();
        name("principal", principal)?;
        // An operator decides for any Task it sees. A client decides only for a Task it owns, its
        // own conversation's turn, once the host confirmed execution stopped (checked below).
        let client = principal
            .strip_prefix("user:")
            .or_else(|| principal.strip_prefix("client:"));
        let operator_id = principal.strip_prefix("operator:");
        let caller_id = operator_id.or(client).ok_or(StoreError::PermissionDenied)?;
        name("caller ID", caller_id)?;
        if client.is_some() && input.confirmed_stopped {
            return Err(StoreError::FailedPrecondition(
                "only an operator can confirm that execution stopped".into(),
            ));
        }
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
            "SELECT operator_principal FROM supertag_v2_attempt_resolutions WHERE attempt_id = $1",
        )
        .bind(&input.attempt_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(principal) = already_resolved {
            return Err(StoreError::Conflict(
                match principal.strip_prefix("host:") {
                    Some(host) => format!(
                        "Worker Host {host} reclaimed this Task Attempt after it proved the Attempt's processes stopped"
                    ),
                    None if principal == AUTOMATIC_PRINCIPAL => "SuperTag already recorded this Task Attempt as failed: its host confirmed it stopped and it recorded no effect".into(),
                    None => "Task Attempt already has a recovery decision".into(),
                },
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
        if client.is_some() {
            // Only the owner, and only once its host confirmed execution stopped, so two
            // executions of the Session cannot overlap. Running it again could repeat what it
            // did, so a client retries only an Attempt that recorded no effect.
            let owner =
                crate::conversations::task_owner_in(&mut transaction, &input.task_id).await?;
            if owner.as_deref() != Some(principal) {
                return Err(StoreError::PermissionDenied);
            }
            if !host_confirmed_stop(&row)? {
                return Err(StoreError::FailedPrecondition(
                    "the Worker Host has not confirmed this Task Attempt stopped; ask an operator"
                        .into(),
                ));
            }
            if decision == AttemptDecision::Retry
                && let Some(effect) = held_for_person_in(&mut transaction, &task).await?
            {
                return Err(StoreError::FailedPrecondition(format!(
                    "only an operator can run this Task again, because {effect}"
                )));
            }
        }

        sqlx::query("INSERT INTO supertag_v2_attempt_resolutions (attempt_id, task_id, operator_principal, operation_id, decision, evidence, confirmed_stopped, resolved_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(&input.attempt_id).bind(&input.task_id).bind(principal).bind(&input.operation_id)
            .bind(i64::from(input.decision)).bind(&input.evidence).bind(i64::from(input.confirmed_stopped))
            .bind(now).execute(&mut *transaction).await?;
        if decision == AttemptDecision::Retry {
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1, result = NULL, attempt_id = NULL, host_principal = NULL, host_generation = NULL, lease_token = NULL, lease_expires_at_ms = NULL, cleanup_pending = 0, cleanup_observed = 0, cleanup_failure = NULL, event_sequence_base = 0, finish_objective_signal = 0 WHERE task_id = $2")
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
            operator_id: operator_id.unwrap_or_default().into(),
            evidence: input.evidence.clone(),
            resolved_at_ms: now,
            client_id: client.unwrap_or_default().into(),
            ..Default::default()
        })
    }

    /// The Attempt's own Worker Host, restarted after it was killed, proves every process it
    /// recorded for the Attempt has stopped. The Control Plane, the scheduler, then decides here
    /// whether the Task runs again: it is redelivered, keeping its ID, as a new Attempt after a
    /// short backoff, when the lost Attempt did nothing that cannot be repeated (see
    /// [`not_redelivered_in`]) and the Task has had fewer than [`MAX_TASK_ATTEMPTS`]. Otherwise it
    /// fails with an unknown outcome, as before, saying why it was not retried, and the operator
    /// Inbox shows it. Effects the Attempt left in doubt keep their own resolution. An operator's
    /// decision, or a Task another Attempt already owns, wins.
    pub async fn reclaim_attempt(
        &self,
        host: &HostAuthority,
        input: &ReclaimAttemptRequest,
    ) -> Result<AttemptResolution> {
        let _wake = self.hint_after_commit();
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Task Attempt is required"))?;
        name("Task ID", &attempt.task_id)?;
        name("Task Attempt ID", &attempt.attempt_id)?;
        name("lease token", &attempt.lease_token)?;
        text("recovery evidence", &input.evidence, 16_384)?;
        if input.evidence.trim().is_empty() {
            return Err(invalid("recovery evidence is required"));
        }
        let (mut transaction, _) = self.write().await?;
        current_scope_in(&mut transaction, host).await?;
        // Only the host that claimed this Attempt, holding its lease token, may reclaim it.
        let claimed: Option<String> = sqlx::query_scalar("SELECT attempt_id FROM supertag_v2_claims WHERE task_id = $1 AND attempt_id = $2 AND principal = $3 AND lease_token = $4")
            .bind(&attempt.task_id).bind(&attempt.attempt_id).bind(&host.principal).bind(&attempt.lease_token)
            .fetch_optional(&mut *transaction).await?;
        if claimed.is_none() {
            return Err(StoreError::PermissionDenied);
        }
        let prior =
            sqlx::query("SELECT * FROM supertag_v2_attempt_resolutions WHERE attempt_id = $1")
                .bind(&attempt.attempt_id)
                .fetch_optional(&mut *transaction)
                .await?;
        if let Some(prior) = prior {
            let resolution = resolution_row(&prior)?;
            if prior.try_get::<String, _>("operator_principal")? == host.principal
                && resolution.evidence == input.evidence
            {
                transaction.rollback().await?;
                return Ok(resolution);
            }
            return Err(StoreError::Conflict(
                "Task Attempt already has a recovery decision".into(),
            ));
        }
        let now = self.execution_now_ms();
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
            .bind(&attempt.task_id)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
        let task = task_row(&row)?;
        if task.attempt_id.as_deref() != Some(attempt.attempt_id.as_str()) {
            return Err(StoreError::FailedPrecondition(
                "Task Attempt no longer owns this Task".into(),
            ));
        }
        if row
            .try_get::<Option<String>, _>("host_principal")?
            .as_deref()
            != Some(host.principal.as_str())
            || row
                .try_get::<Option<i64>, _>("host_generation")?
                .is_none_or(|generation| generation > host.generation)
            || row.try_get::<Option<String>, _>("lease_token")?.as_deref()
                != Some(attempt.lease_token.as_str())
        {
            return Err(StoreError::PermissionDenied);
        }
        let cleanup_pending = row.try_get::<i64, _>("cleanup_pending")? == 1;
        let state = match task.state() {
            TaskState::Running | TaskState::Uncertain => TaskState::Failed,
            TaskState::Cancelled if cleanup_pending => TaskState::Cancelled,
            _ => {
                return Err(StoreError::FailedPrecondition(
                    "Task Attempt does not require recovery".into(),
                ));
            }
        };
        // A cancelled Task stays cancelled; a failed one may run again.
        let not_redelivered = match state {
            TaskState::Failed => {
                not_redelivered_in(&mut transaction, &task, &attempt.attempt_id).await?
            }
            _ => None,
        };
        let decision = if state == TaskState::Failed && not_redelivered.is_none() {
            AttemptDecision::Retry
        } else {
            AttemptDecision::Failed
        };
        sqlx::query("INSERT INTO supertag_v2_attempt_resolutions (attempt_id, task_id, operator_principal, operation_id, decision, evidence, confirmed_stopped, resolved_at_ms, not_redelivered_reason) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8)")
            .bind(&attempt.attempt_id).bind(&attempt.task_id).bind(&host.principal).bind(&attempt.attempt_id)
            .bind(decision as i64).bind(&input.evidence).bind(now).bind(&not_redelivered)
            .execute(&mut *transaction).await?;
        if decision == AttemptDecision::Retry {
            let started = started_attempts_in(&mut transaction, &attempt.task_id).await?;
            let backoff = REDELIVERY_BACKOFF_MS[usize::try_from(started - 1)
                .unwrap_or(0)
                .min(REDELIVERY_BACKOFF_MS.len() - 1)];
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1, result = NULL, attempt_id = NULL, host_principal = NULL, host_generation = NULL, lease_token = NULL, lease_expires_at_ms = NULL, cleanup_pending = 0, cleanup_observed = 0, cleanup_failure = NULL, event_sequence_base = 0, finish_objective_signal = 0, redeliver_after_ms = $2 WHERE task_id = $3")
                .bind(TaskState::Queued as i64).bind(now.saturating_add(backoff)).bind(&attempt.task_id)
                .execute(&mut *transaction).await?;
            // Messages the lost Attempt was given or may have read are covered by the redelivery.
            crate::session_inputs::redeliver_in(
                &mut transaction,
                &attempt.task_id,
                &attempt.attempt_id,
                now,
            )
            .await?;
        } else {
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1, result = COALESCE(result, $2), cleanup_pending = 0, cleanup_observed = 1, cleanup_failure = NULL WHERE task_id = $3")
                // A cancelled Task keeps its cancellation as its result.
                .bind(state as i64).bind(not_redelivered.as_deref().map(reclaimed_result)).bind(&attempt.task_id)
                .execute(&mut *transaction).await?;
        }
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        transaction.commit().await?;
        Ok(AttemptResolution {
            task_id: attempt.task_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            decision: decision as i32,
            operator_id: String::new(),
            evidence: input.evidence.clone(),
            resolved_at_ms: now,
            worker_host_id: host.id().into(),
            ..Default::default()
        })
    }

    /// Records the limits the running Attempt's adapter confirmed it applies, for the Task
    /// execution report. A repeated report must match the first.
    pub async fn report_applied_limits(
        &self,
        host: &HostAuthority,
        input: &ReportAppliedLimitsRequest,
    ) -> Result<()> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Task Attempt is required"))?;
        let applied = input
            .applied
            .as_ref()
            .filter(|applied| applied.limits.is_some() && applied.encoded_len() <= 4096)
            .ok_or_else(|| invalid("applied execution limits are required"))?
            .encode_to_vec();
        let (mut transaction, _) = self.write().await?;
        let row = owned(
            &mut transaction,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let task = task_row(&row)?;
        if task.execution_limits.is_none() {
            return Err(invalid("Task has no execution limits"));
        }
        match row.try_get::<Option<Vec<u8>>, _>("applied_execution_limits")? {
            Some(prior) if prior == applied => {
                transaction.rollback().await?;
                return Ok(());
            }
            Some(_) => {
                return Err(StoreError::Conflict(
                    "Task Attempt already reported different applied limits".into(),
                ));
            }
            None if task.state() != TaskState::Running => {
                return Err(StoreError::FailedPrecondition("Task is not running".into()));
            }
            None => {}
        }
        sqlx::query(
            "UPDATE supertag_v2_tasks SET applied_execution_limits = $1 WHERE task_id = $2",
        )
        .bind(applied)
        .bind(&attempt.task_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
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
    task.execution_limits.as_ref().is_none_or(|limits| {
        crate::placement::unsupported_execution_limits(harness, limits).is_none()
    })
}

fn supports_runtime_actions(harness: HarnessKind, task: &Task) -> bool {
    crate::placement::unsupported_runtime_actions(harness, &task.allowed_actions).is_none()
}

/// What a Worker Host's claim can run: its identity and Tag scope, and the capabilities its claim
/// declared, normalized.
#[derive(Clone)]
pub(crate) struct ClaimScope {
    pub(crate) host_id: String,
    pub(crate) generation: i64,
    pub(crate) all_tags: i64,
    pub(crate) workspace_ids: Vec<String>,
    pub(crate) gateway_workspace_ids: Vec<String>,
    pub(crate) harness: HarnessKind,
    pub(crate) profile: HarnessExecutionProfile,
    pub(crate) contracts: Vec<supertag_protocol::v2::ContextContract>,
}

/// How long a Session stays warm on the host its last Task finished on.
const WARM_MS: i64 = 5 * 60 * 1000;
/// How long a new Task of a warm Session is left for its warm host.
const STICKY_MS: i64 = 2_000;

/// Records that `task`'s Session is warm on `host_id`, the host it just finished on, and drops
/// leases that have run out.
pub(crate) async fn warm_in(
    transaction: &mut Transaction<'_, Any>,
    task: &Task,
    host_id: &str,
    now: i64,
) -> Result<()> {
    sqlx::query("DELETE FROM supertag_v2_warm_sessions WHERE warm_until_ms <= $1")
        .bind(now)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(
        "INSERT INTO supertag_v2_warm_sessions (tag_id,session_id,host_id,warm_until_ms)
         VALUES ($1,$2,$3,$4) ON CONFLICT(tag_id,session_id)
         DO UPDATE SET host_id=excluded.host_id, warm_until_ms=excluded.warm_until_ms",
    )
    .bind(&task.tag_id)
    .bind(&task.session_id)
    .bind(host_id)
    .bind(now + WARM_MS)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// A host's labels and its Tags' required labels, read once per claim.
struct Placement {
    labels: BTreeSet<String>,
    runs_on: crate::placement::RunsOnCache,
}

impl ClaimScope {
    fn contracts(&self) -> &[supertag_protocol::v2::ContextContract] {
        if matches!(
            self.harness,
            HarnessKind::Opencode | HarnessKind::OpenaiAgents | HarnessKind::Cursor
        ) {
            &[]
        } else {
            &self.contracts
        }
    }

    async fn placement(&self, transaction: &mut Transaction<'_, Any>) -> Result<Placement> {
        // Labels narrow the bound hosts; they never add a Tag to this host's scope.
        let labels = crate::placement::claim_labels_in(
            transaction,
            (&self.host_id, self.generation),
            self.harness,
            &[self.workspace_ids.as_slice(), &self.gateway_workspace_ids].concat(),
            &self.profile,
        )
        .await?;
        Ok(Placement {
            labels,
            runs_on: crate::placement::RunsOnCache::default(),
        })
    }

    async fn serves(&self, transaction: &mut Transaction<'_, Any>, task: &Task) -> Result<bool> {
        // A host for every Tag runs shared Tags; a personal Tag runs only where it is bound. A
        // host bound for a Tag's Work Sessions runs only Tasks in them.
        if self.all_tags == 1
            && crate::store::users::owner_in(transaction, &task.tag_id)
                .await?
                .is_none()
        {
            return Ok(true);
        }
        Ok(sqlx::query_scalar::<_, i64>(
            "SELECT CAST(1 AS BIGINT) FROM supertag_v2_host_tags WHERE host_id=$1 AND tag_id=$2 AND (work_sessions_only=0 OR $3 LIKE 'work/%')",
        )
        .bind(&self.host_id)
        .bind(&task.tag_id)
        .bind(&task.session_id)
        .fetch_optional(&mut **transaction)
        .await?
        .is_some())
    }

    /// How this host would run `task`, if it may: placement, path scope, Workspace, harness,
    /// limits, context and the Task's own admission rules.
    async fn admits(
        &self,
        transaction: &mut Transaction<'_, Any>,
        placement: &mut Placement,
        now: i64,
        task: &Task,
        accepted_order: i64,
    ) -> Result<Option<AttemptExecutionSelection>> {
        let has_workspace = task.workspace.as_ref().is_none_or(|spec| {
            let sources = if spec.remote.is_some() {
                &self.gateway_workspace_ids
            } else {
                &self.workspace_ids
            };
            sources.binary_search(&spec.workspace_id).is_ok()
        });
        let Some(attempt_execution) = execution::resolve_attempt(task, self.harness, &self.profile)
        else {
            return Ok(None);
        };
        let admitted = has_workspace
            && placement
                .runs_on
                .admits(transaction, &task.tag_id, &placement.labels)
                .await?
            && crate::workspace_mounts::current_in(transaction, task).await?
            && task.workspace.as_ref().is_none_or(|spec| {
                supertag_protocol::valid_git_commit(&spec.base_commit)
                        // A followed branch is resolved by the host that runs the Attempt.
                        || (spec.base_commit.is_empty()
                            && !spec.base_ref.is_empty()
                            && spec.remote.is_none())
            })
            && supports_execution_limits(self.harness, task)
            && supports_runtime_actions(self.harness, task)
            && crate::context::task_supported(task, self.contracts())
            && crate::inputs::can_claim_in(transaction, task, accepted_order).await?
            && crate::objectives::objective_task_can_start_in(transaction, task, now).await?
            && crate::start_rates::can_start_in(transaction, task, now).await?;
        Ok(admitted.then_some(attempt_execution))
    }
}

pub(super) async fn claim_candidate(
    transaction: &mut Transaction<'_, Any>,
    now: i64,
    scope: &ClaimScope,
    (waiting, sandboxed): (&HashMap<String, Vec<ClaimScope>>, &[ClaimScope]),
) -> Result<Option<(String, AttemptExecutionSelection)>> {
    let mut placement = scope.placement(transaction).await?;
    let mut after = 0_i64;
    loop {
        // A redelivered Task waits out its backoff, and the later Tasks of its Session wait
        // behind it.
        let candidates = sqlx::query("SELECT pending.task_id, pending.accepted_order FROM supertag_v2_tasks pending WHERE pending.state = $1 AND pending.accepted_order > $2 AND pending.harness_kind IN (0,$8) AND (pending.redeliver_after_ms IS NULL OR pending.redeliver_after_ms <= $9) AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks active WHERE active.tag_id = pending.tag_id AND active.session_id = pending.session_id AND (active.state IN ($3,$4,$5) OR active.cleanup_pending = 1 OR (active.state = $1 AND active.redeliver_after_ms > $9 AND active.accepted_order < pending.accepted_order))) AND (($6 = 1 AND NOT EXISTS (SELECT 1 FROM supertag_v2_tags owned WHERE owned.tag_id=pending.tag_id AND owned.owner_user IS NOT NULL)) OR EXISTS (SELECT 1 FROM supertag_v2_host_tags scope WHERE scope.host_id=$7 AND scope.tag_id=pending.tag_id AND (scope.work_sessions_only=0 OR pending.session_id LIKE 'work/%'))) ORDER BY pending.accepted_order LIMIT 32")
            .bind(TaskState::Queued as i64).bind(after).bind(TaskState::Claimed as i64)
            .bind(TaskState::Running as i64).bind(TaskState::Uncertain as i64).bind(scope.all_tags).bind(&scope.host_id).bind(scope.harness as i64).bind(now)
            .fetch_all(&mut **transaction).await?;
        let last_page = candidates.len() < 32;
        for candidate in candidates {
            let id: String = candidate.try_get("task_id")?;
            let accepted_order: i64 = candidate.try_get("accepted_order")?;
            after = accepted_order;
            let task = task_in(transaction, &id).await?;
            let Some(attempt_execution) = scope
                .admits(transaction, &mut placement, now, &task, accepted_order)
                .await?
            else {
                continue;
            };
            if left_for_warm_host(transaction, now, scope, (&task, accepted_order), waiting).await?
            {
                continue;
            }
            // A local Workspace's Session continues only on the host holding its last delivery.
            if crate::workspaces::local_holder_wait_in(transaction, &task, Some(&scope.host_id))
                .await?
                .is_some()
            {
                continue;
            }
            // The host holding the Session's checkpoint resumes it; others leave it for a while.
            if crate::checkpoints::holder_wait_in(transaction, &task, Some(&scope.host_id), now)
                .await?
                .is_some()
            {
                continue;
            }
            if left_for_sandboxed_lane(transaction, now, scope, &task, accepted_order, sandboxed)
                .await?
            {
                continue;
            }
            return Ok(Some((id, attempt_execution)));
        }
        if last_page {
            return Ok(None);
        }
    }
}

/// Whether a new Task of a warm Session is left, for a moment, to the host it last ran on.
/// When that host's waiting claims are held by this replica, it is left only if one of them may
/// run the Task. A claim held by another replica, or a lease from before a restart, is judged by
/// the host's recorded status: ready with a free slot, bound to the Tag, and running the Task's
/// harness. A busy, draining, or gone warm host is not waited for.
async fn left_for_warm_host(
    transaction: &mut Transaction<'_, Any>,
    now: i64,
    claimer: &ClaimScope,
    (task, accepted_order): (&Task, i64),
    waiting: &HashMap<String, Vec<ClaimScope>>,
) -> Result<bool> {
    let Some(row) = sqlx::query(
        "SELECT w.host_id,t.accepted_at_ms FROM supertag_v2_warm_sessions w
         JOIN supertag_v2_tasks t ON t.task_id=$3
         WHERE w.tag_id=$1 AND w.session_id=$2 AND w.warm_until_ms>$4",
    )
    .bind(&task.tag_id)
    .bind(&task.session_id)
    .bind(&task.task_id)
    .bind(now)
    .fetch_optional(&mut **transaction)
    .await?
    else {
        return Ok(false);
    };
    let warm: String = row.try_get("host_id")?;
    let accepted_at: Option<i64> = row.try_get("accepted_at_ms")?;
    if warm == claimer.host_id || accepted_at.is_none_or(|at| at + STICKY_MS <= now) {
        return Ok(false);
    }
    match waiting.get(&warm) {
        Some(scopes) => any_admits(transaction, now, task, accepted_order, scopes).await,
        None => crate::placement::ready_for_in(transaction, &warm, task, now).await,
    }
}

/// Whether a Task that runs commands is left to a sandboxed lane waiting to claim now, rather
/// than taken by a lane that runs commands unsandboxed on its Worker Host. A busy sandboxed
/// lane leaves it to the unsandboxed one.
async fn left_for_sandboxed_lane(
    transaction: &mut Transaction<'_, Any>,
    now: i64,
    scope: &ClaimScope,
    task: &Task,
    accepted_order: i64,
    sandboxed: &[ClaimScope],
) -> Result<bool> {
    if !scope.profile.allow_unsandboxed_commands
        || !task
            .allowed_actions
            .iter()
            .any(|action| action == "commands:execute")
    {
        return Ok(false);
    }
    any_admits(transaction, now, task, accepted_order, sandboxed).await
}

/// Whether any of `scopes`, waiting claims, would claim `task` now.
async fn any_admits(
    transaction: &mut Transaction<'_, Any>,
    now: i64,
    task: &Task,
    accepted_order: i64,
    scopes: &[ClaimScope],
) -> Result<bool> {
    for scope in scopes {
        if (task.harness_kind == 0 || task.harness_kind == scope.harness as i32)
            && scope.serves(transaction, task).await?
        {
            let mut placement = scope.placement(transaction).await?;
            if scope
                .admits(transaction, &mut placement, now, task, accepted_order)
                .await?
                .is_some()
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
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

/// How many Attempts of `task_id` started their harness, the interrupted one included.
async fn started_attempts_in(transaction: &mut Transaction<'_, Any>, task_id: &str) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT CAST(COUNT(*) AS BIGINT) FROM supertag_v2_claims WHERE task_id = $1 AND started_at_ms IS NOT NULL",
    )
    .bind(task_id)
    .fetch_one(&mut **transaction)
    .await?)
}

/// Why the interrupted `attempt_id` of `task` may not run again, or `None` when the Task is
/// redelivered. Redelivery is on for every Tag (operator decision, 2026-11-19). It is refused
/// when the lost Attempt did something that repeating could do twice: an effect it began never
/// settled; it started a delivery of the Session's changes, published an artifact, or its reply
/// was already shown; an action that needed approval ran; or it could run a command with the
/// network reachable outside a sandbox (see [`commands_reach_network`]). It is also refused once
/// the Task has had [`MAX_TASK_ATTEMPTS`].
pub(crate) async fn not_redelivered_in(
    transaction: &mut Transaction<'_, Any>,
    task: &Task,
    attempt_id: &str,
) -> Result<Option<String>> {
    let any = |sql: &'static str| sqlx::query_scalar::<_, i64>(sql).bind(attempt_id.to_owned());
    // A STARTED effect receipt of an ended Attempt is in doubt: the provider may have committed
    // it. So is an MCP call the Control Plane brokered that is still reserved or unconfirmed.
    if any("SELECT CAST(1 AS BIGINT) FROM supertag_v2_effect_receipts WHERE attempt_id = $1 AND state = 1")
        .fetch_optional(&mut **transaction)
        .await?
        .is_some()
        || any("SELECT CAST(1 AS BIGINT) FROM supertag_v2_mcp_effects WHERE attempt_id = $1 AND state IN (1,3)")
            .fetch_optional(&mut **transaction)
            .await?
            .is_some()
    {
        return Ok(Some(
            "an external write it started never reported its outcome".into(),
        ));
    }
    if any("SELECT CAST(1 AS BIGINT) FROM supertag_v2_workspace_deliveries WHERE attempt_id = $1")
        .fetch_optional(&mut **transaction)
        .await?
        .is_some()
    {
        return Ok(Some("it started delivering the Session's changes".into()));
    }
    if any("SELECT CAST(1 AS BIGINT) FROM supertag_v2_artifact_captures WHERE attempt_id = $1")
        .fetch_optional(&mut **transaction)
        .await?
        .is_some()
    {
        return Ok(Some("it published an artifact".into()));
    }
    // A running Task has a result only once its harness finished and its reply was shown.
    if task.result.is_some() {
        return Ok(Some("its reply was already sent".into()));
    }
    // An approval granted to this Attempt was consumed by its action. A brokered MCP call
    // always runs under an approval, so one it confirmed ran too.
    if any("SELECT CAST(1 AS BIGINT) FROM supertag_v2_approval_operations WHERE attempt_id = $1 AND granted = 1")
        .fetch_optional(&mut **transaction)
        .await?
        .is_some()
        || any("SELECT CAST(1 AS BIGINT) FROM supertag_v2_mcp_effects WHERE attempt_id = $1")
            .fetch_optional(&mut **transaction)
            .await?
            .is_some()
    {
        return Ok(Some("it ran an action that needed approval".into()));
    }
    let claim = sqlx::query(
        "SELECT harness_kind, execution_profile FROM supertag_v2_claims WHERE attempt_id = $1",
    )
    .bind(attempt_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let reaches_network = match &claim {
        Some(claim) => commands_reach_network(
            task,
            HarnessKind::try_from(claim.try_get::<i64, _>("harness_kind")? as i32)
                .unwrap_or(HarnessKind::Unspecified),
            &execution::read_profile(claim.try_get("execution_profile")?)?.unwrap_or_default(),
        ),
        None => true,
    };
    if reaches_network {
        return Ok(Some(
            "it could run commands with network access outside a sandbox".into(),
        ));
    }
    if started_attempts_in(transaction, &task.task_id).await? >= MAX_TASK_ATTEMPTS {
        return Ok(Some(format!(
            "it had already run {MAX_TASK_ATTEMPTS} Task Attempts"
        )));
    }
    Ok(None)
}

/// Whether an Attempt of `task` on a `harness` lane with `profile` may have run a command that
/// reached the network outside a sandbox. Nothing records it precisely: a Worker's activity
/// events are display text, and its network log sees only traffic through the egress proxy, not
/// an unsandboxed command's. So this reads what the Task was admitted with and how the lane runs
/// commands, conservatively. A Task without `commands:execute` runs none. One with it is safe
/// only where every command runs in a sandbox without network: Codex's own sandbox on its
/// Worker Host, or a Claude Code command sandbox, and only while the Task has no `web:fetch`,
/// which opens that sandbox's network (directly for Codex, through the egress proxy for Claude
/// Code). Unsandboxed lanes, remote Workspace sandboxes, and shared execution count as reaching
/// the network.
pub(crate) fn commands_reach_network(
    task: &Task,
    harness: HarnessKind,
    profile: &HarnessExecutionProfile,
) -> bool {
    let admitted = |action: &str| task.allowed_actions.iter().any(|granted| granted == action);
    if !admitted("commands:execute") {
        return false;
    }
    let sandboxed = !profile.allow_unsandboxed_commands
        && !profile.remote_file_workspace
        && profile.shared_execution.is_none()
        && (harness == HarnessKind::Codex
            || (harness == HarnessKind::ClaudeCode && profile.command_sandbox));
    !sandboxed || admitted("web:fetch")
}

/// What a new Attempt of `task_id` is told about its Task's interrupted Attempts, when it had
/// any: how many, and the message events they published, which a new Attempt's events follow.
pub(crate) async fn redelivery_in(
    transaction: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<Option<supertag_protocol::v2::Redelivery>> {
    let interrupted: i64 = sqlx::query_scalar(
        "SELECT CAST(COUNT(*) AS BIGINT) FROM supertag_v2_attempt_resolutions WHERE task_id = $1 AND decision = $2",
    )
    .bind(task_id)
    .bind(AttemptDecision::Retry as i64)
    .fetch_one(&mut **transaction)
    .await?;
    if interrupted == 0 {
        return Ok(None);
    }
    let rows = sqlx::query(
        "SELECT e.text FROM supertag_v2_task_events e JOIN supertag_v2_tasks t ON t.task_id = e.task_id
         WHERE e.task_id = $1 AND e.kind = $2 AND e.sequence <= t.event_sequence_base
         ORDER BY e.sequence DESC LIMIT $3",
    )
    .bind(task_id)
    .bind(supertag_protocol::v2::TaskEventKind::Message as i64)
    .bind(ALREADY_SAID_MESSAGES)
    .fetch_all(&mut **transaction)
    .await?;
    let mut already_said = Vec::new();
    let mut bytes = 0;
    for row in rows {
        let text: String = row.try_get("text")?;
        bytes += text.len();
        if bytes > ALREADY_SAID_BYTES {
            break;
        }
        already_said.push(text);
    }
    already_said.reverse();
    Ok(Some(supertag_protocol::v2::Redelivery {
        interrupted_attempts: u32::try_from(interrupted).unwrap_or(u32::MAX),
        already_said,
    }))
}

/// The first effect SuperTag recorded for `task` that a person must judge before its uncertain
/// Attempt is settled, in plain words, or `None` when it recorded none. Any Attempt of the Task
/// counts, so this is conservative: a reply, a message it already said, or a post to the person
/// or a collaboration surface; an external write or an MCP call; an approved action; a delivery,
/// a Volume write, or a published artifact; a message to another Tag or a Team; or a
/// Work Session, Schedule, question, commit review, or note it started. Commands and files a
/// harness touched outside SuperTag leave no record; a failed decision never runs them again.
pub(crate) async fn held_for_person_in(
    transaction: &mut Transaction<'_, Any>,
    task: &Task,
) -> Result<Option<String>> {
    if task.result.is_some() {
        return Ok(Some("its reply was already sent".into()));
    }
    // Kind 1 is `TaskEventKind::Message`, a message the Tag wrote to the person.
    const EFFECTS: &[(&str, &str)] = &[
        (
            "SELECT 1 FROM supertag_v2_task_events WHERE task_id=$1 AND kind=1",
            "it already said something to the person",
        ),
        (
            "SELECT 1 FROM supertag_v2_proactive_posts WHERE task_id=$1",
            "it already posted to the conversation",
        ),
        (
            "SELECT 1 FROM supertag_v2_replies WHERE task_id=$1",
            "its reply to a collaboration surface was queued",
        ),
        (
            "SELECT 1 FROM supertag_v2_reply_progress WHERE task_id=$1 AND revision>1",
            "it posted progress to a collaboration surface",
        ),
        (
            "SELECT 1 FROM supertag_v2_effect_receipts WHERE task_id=$1",
            "it made an external write",
        ),
        (
            "SELECT 1 FROM supertag_v2_mcp_effects WHERE task_id=$1",
            "it called an MCP tool that needed approval",
        ),
        (
            "SELECT 1 FROM supertag_v2_approval_operations WHERE granted=1 AND attempt_id IN (SELECT attempt_id FROM supertag_v2_claims WHERE task_id=$1)",
            "it ran an action that needed approval",
        ),
        (
            "SELECT 1 FROM supertag_v2_workspace_deliveries WHERE task_id=$1",
            "it started delivering the Session's changes",
        ),
        (
            "SELECT 1 FROM supertag_v2_workspace_landings WHERE task_id=$1",
            "it started delivering the Session's changes",
        ),
        (
            "SELECT 1 FROM supertag_v2_workspace_mount_writes WHERE task_id=$1",
            "it wrote to a Volume",
        ),
        (
            "SELECT 1 FROM supertag_v2_artifact_captures WHERE task_id=$1",
            "it published an artifact",
        ),
        (
            "SELECT 1 FROM supertag_v2_messages WHERE source_task_id=$1",
            "it sent a message to another Tag, a Team, or the person",
        ),
        (
            "SELECT 1 FROM supertag_v2_work_session_starts WHERE starter_task_id=$1",
            "it started a Work Session",
        ),
        (
            "SELECT 1 FROM supertag_v2_schedules WHERE origin_task_id=$1",
            "it created a Schedule",
        ),
        (
            "SELECT 1 FROM supertag_v2_objective_questions WHERE task_id=$1",
            "it asked a question",
        ),
        (
            "SELECT 1 FROM supertag_v2_work_session_questions WHERE task_id=$1",
            "it asked a question",
        ),
        (
            "SELECT 1 FROM supertag_v2_commit_reviews WHERE source_task_id=$1",
            "it requested a commit review",
        ),
    ];
    for (sql, reason) in EFFECTS {
        let found: Option<i64> =
            sqlx::query_scalar(&format!("SELECT CAST(1 AS BIGINT) WHERE EXISTS ({sql})"))
                .bind(&task.task_id)
                .fetch_optional(&mut **transaction)
                .await?;
        if found.is_some() {
            return Ok(Some((*reason).into()));
        }
    }
    Ok(None)
}

/// Whether the host of the uncertain Attempt in `row` confirmed its execution stopped (a Finish
/// after its lease lapsed, or the removal of an ephemeral host) and reported no cleanup failure.
pub(crate) fn host_confirmed_stop(row: &AnyRow) -> Result<bool> {
    Ok(
        row.try_get::<i64, _>("state")? == TaskState::Uncertain as i64
            && row.try_get::<i64, _>("cleanup_observed")? == 1
            && row
                .try_get::<Option<String>, _>("cleanup_failure")?
                .is_none(),
    )
}

/// When SuperTag records the uncertain Attempt in `row` as failed on its own, or `None` when a
/// person must decide: its host confirmed it stopped, and `held`, whether the Task recorded an
/// effect (see [`held_for_person_in`]), is false.
pub(crate) fn auto_resolve_at(row: &AnyRow, held: bool) -> Result<Option<i64>> {
    if held || !host_confirmed_stop(row)? {
        return Ok(None);
    }
    Ok(Some(
        row.try_get::<Option<i64>, _>("lease_expires_at_ms")?
            .unwrap_or(0)
            .saturating_add(AUTO_RESOLVE_GRACE_MS),
    ))
}

/// Records as failed each uncertain Task Attempt whose host confirmed it stopped, once
/// [`AUTO_RESOLVE_GRACE_MS`] passed since its lease lapsed, when the Task recorded nothing a
/// person must judge (see [`held_for_person_in`]). The decision is recorded and audited as
/// [`AUTOMATIC_PRINCIPAL`], the Task's result says why, and the Session's next turn may run.
/// Every other uncertain Attempt waits for a person. Failing runs nothing again, so it cannot
/// repeat an effect.
pub(super) async fn settle_stopped_uncertain_in(
    transaction: &mut Transaction<'_, Any>,
    now: i64,
) -> Result<u64> {
    let rows = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE state=$1 AND cleanup_observed=1 AND cleanup_failure IS NULL AND attempt_id IS NOT NULL AND lease_expires_at_ms<=$2 ORDER BY lease_expires_at_ms,task_id LIMIT 100")
        .bind(TaskState::Uncertain as i64)
        .bind(now.saturating_sub(AUTO_RESOLVE_GRACE_MS))
        .fetch_all(&mut **transaction)
        .await?;
    let mut settled = 0;
    for row in rows {
        let task = task_row(&row)?;
        let Some(attempt_id) = task.attempt_id.clone() else {
            continue;
        };
        let held = held_for_person_in(transaction, &task).await?.is_some();
        if auto_resolve_at(&row, held)?.is_none_or(|at| at > now) {
            continue;
        }
        let decided: Option<i64> = sqlx::query_scalar(
            "SELECT CAST(1 AS BIGINT) FROM supertag_v2_attempt_resolutions WHERE attempt_id=$1",
        )
        .bind(&attempt_id)
        .fetch_optional(&mut **transaction)
        .await?;
        if decided.is_some() {
            continue;
        }
        let evidence = format!(
            "Recorded as failed by SuperTag {} s after the lease lapsed: the Worker Host confirmed execution stopped, and the Task recorded no reply, message, delivery, artifact, or other effect.",
            AUTO_RESOLVE_GRACE_MS / 1000
        );
        sqlx::query("INSERT INTO supertag_v2_attempt_resolutions (attempt_id, task_id, operator_principal, operation_id, decision, evidence, confirmed_stopped, resolved_at_ms) VALUES ($1,$2,$3,$4,$5,$6,1,$7)")
            .bind(&attempt_id).bind(&task.task_id).bind(AUTOMATIC_PRINCIPAL).bind(&attempt_id)
            .bind(AttemptDecision::Failed as i64).bind(&evidence).bind(now)
            .execute(&mut **transaction).await?;
        sqlx::query("UPDATE supertag_v2_tasks SET state=$1, result=COALESCE(result,$2), cleanup_pending=0, cleanup_observed=1 WHERE task_id=$3 AND state=$4")
            .bind(TaskState::Failed as i64).bind(AUTO_FAILED_RESULT).bind(&task.task_id).bind(TaskState::Uncertain as i64)
            .execute(&mut **transaction).await?;
        crate::audit::insert_in(
            transaction,
            None,
            now,
            crate::operator_access::AuditRecord {
                actor: AUTOMATIC_PRINCIPAL.into(),
                action: "attempt.resolve".into(),
                target: format!("Task/{}", task.task_id),
                succeeded: true,
                code: "OK".into(),
                method: "automatic".into(),
            },
            "Task",
        )
        .await?;
        settled += 1;
    }
    if settled > 0 {
        crate::objectives::objective_sweep_in(transaction, now).await?;
    }
    Ok(settled)
}

/// The operator Inbox's reason for a Task that was not redelivered.
pub(crate) fn not_redelivered_notice(task_id: &str, tag_id: &str, reason: &str) -> String {
    format!(
        "Task {task_id} of Tag {tag_id} was interrupted when its Worker was lost, and SuperTag did not run it again because {reason}. Check what it did before you run it again."
    )
}

pub(crate) fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn resolution_row(row: &AnyRow) -> Result<AttemptResolution> {
    let principal: String = row.try_get("operator_principal")?;
    let mut resolution = AttemptResolution {
        task_id: row.try_get("task_id")?,
        attempt_id: row.try_get("attempt_id")?,
        decision: row.try_get::<i64, _>("decision")? as i32,
        evidence: row.try_get("evidence")?,
        resolved_at_ms: row.try_get("resolved_at_ms")?,
        ..Default::default()
    };
    if let Some(operator) = principal.strip_prefix("operator:") {
        resolution.operator_id = operator.into();
    } else if let Some(host) = principal.strip_prefix("host:") {
        resolution.worker_host_id = host.into();
    } else if principal.starts_with("user:") {
        // A User decided, from one of their devices.
        resolution.client_id = principal;
    } else if let Some(client) = principal.strip_prefix("client:") {
        resolution.client_id = client.into();
    } else if principal == AUTOMATIC_PRINCIPAL {
        resolution.automatic = true;
    } else {
        return Err(StoreError::PermissionDenied);
    }
    Ok(resolution)
}

#[cfg(test)]
mod redelivery_tests {
    use super::*;

    fn task(actions: &[&str]) -> Task {
        Task {
            allowed_actions: actions.iter().map(|action| (*action).to_owned()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn only_commands_in_a_sandbox_without_network_are_safe_to_repeat() {
        let plain = HarnessExecutionProfile::default();
        let unsandboxed = HarnessExecutionProfile {
            allow_unsandboxed_commands: true,
            ..Default::default()
        };
        let command_sandbox = HarnessExecutionProfile {
            command_sandbox: true,
            network_sandbox: true,
            ..Default::default()
        };
        let remote = HarnessExecutionProfile {
            remote_file_workspace: true,
            ..Default::default()
        };
        let commands = task(&["files:write", "commands:execute"]);
        let online = task(&["commands:execute", "web:fetch"]);
        // A Task that runs no commands is safe anywhere, even with web:fetch.
        for harness in [HarnessKind::ClaudeCode, HarnessKind::Opencode] {
            assert!(!commands_reach_network(
                &task(&["files:write", "web:fetch"]),
                harness,
                &unsandboxed
            ));
        }
        // Codex's own sandbox and Claude Code's command sandbox have no network without web:fetch.
        assert!(!commands_reach_network(
            &commands,
            HarnessKind::Codex,
            &plain
        ));
        assert!(!commands_reach_network(
            &commands,
            HarnessKind::ClaudeCode,
            &command_sandbox
        ));
        assert!(commands_reach_network(&online, HarnessKind::Codex, &plain));
        assert!(commands_reach_network(
            &online,
            HarnessKind::ClaudeCode,
            &command_sandbox
        ));
        // Unsandboxed lanes, remote Workspace sandboxes, and harnesses without a sandbox do not
        // count as sandboxed.
        assert!(commands_reach_network(
            &commands,
            HarnessKind::ClaudeCode,
            &unsandboxed
        ));
        assert!(commands_reach_network(
            &commands,
            HarnessKind::Opencode,
            &unsandboxed
        ));
        assert!(commands_reach_network(
            &commands,
            HarnessKind::Codex,
            &remote
        ));
        assert!(commands_reach_network(
            &commands,
            HarnessKind::ClaudeCode,
            &plain
        ));
        assert!(commands_reach_network(
            &commands,
            HarnessKind::Unspecified,
            &plain
        ));
    }
}
