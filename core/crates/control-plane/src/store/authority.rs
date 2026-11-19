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
/// The result a reclaimed Attempt's Task records when it has none, as TypeScript's
/// `InterruptedExecutionOutcomeUnknown` failure says.
const RECLAIMED_RESULT: &str = "Execution was interrupted before the harness finished. The host confirmed that every process it started for this Attempt is gone. The outcome is unknown, and the Task does not run again automatically.";

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
        let _wake = self.wake_follows();
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
        let _wake = self.wake_follows();
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
            "SELECT operator_principal FROM supertag_v2_attempt_resolutions WHERE attempt_id = $1",
        )
        .bind(&input.attempt_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(principal) = already_resolved {
            return Err(StoreError::Conflict(
                match principal.strip_prefix("host:") {
                    Some(host) => format!(
                        "Worker Host {host} reclaimed this Task Attempt as failed after it proved the Attempt's processes stopped"
                    ),
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
            operator_id: operator_id.into(),
            evidence: input.evidence.clone(),
            resolved_at_ms: now,
            worker_host_id: String::new(),
        })
    }

    /// The Attempt's own Worker Host, restarted after it was killed, proves every process it
    /// recorded for the Attempt has stopped. Like TypeScript's automatic reclaim, this records a
    /// failed Attempt whose outcome remains unknown: the Task never runs again on its own, and
    /// effects the Attempt left in doubt keep their own resolution. An operator's decision, or a
    /// Task another Attempt already owns, wins.
    pub async fn reclaim_attempt(
        &self,
        host: &HostAuthority,
        input: &ReclaimAttemptRequest,
    ) -> Result<AttemptResolution> {
        let _wake = self.wake_follows();
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
        sqlx::query("INSERT INTO supertag_v2_attempt_resolutions (attempt_id, task_id, operator_principal, operation_id, decision, evidence, confirmed_stopped, resolved_at_ms) VALUES ($1,$2,$3,$4,$5,$6,1,$7)")
            .bind(&attempt.attempt_id).bind(&attempt.task_id).bind(&host.principal).bind(&attempt.attempt_id)
            .bind(AttemptDecision::Failed as i64).bind(&input.evidence).bind(now)
            .execute(&mut *transaction).await?;
        sqlx::query("UPDATE supertag_v2_tasks SET state = $1, result = COALESCE(result, $2), cleanup_pending = 0, cleanup_observed = 1, cleanup_failure = NULL WHERE task_id = $3")
            // A cancelled Task keeps its cancellation as its result.
            .bind(state as i64).bind((state == TaskState::Failed).then_some(RECLAIMED_RESULT)).bind(&attempt.task_id)
            .execute(&mut *transaction).await?;
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        transaction.commit().await?;
        Ok(AttemptResolution {
            task_id: attempt.task_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            decision: AttemptDecision::Failed as i32,
            operator_id: String::new(),
            evidence: input.evidence.clone(),
            resolved_at_ms: now,
            worker_host_id: host.id().into(),
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

    async fn serves(&self, transaction: &mut Transaction<'_, Any>, tag_id: &str) -> Result<bool> {
        if self.all_tags == 1 {
            return Ok(true);
        }
        Ok(sqlx::query_scalar::<_, i64>(
            "SELECT CAST(1 AS BIGINT) FROM supertag_v2_host_tags WHERE host_id=$1 AND tag_id=$2",
        )
        .bind(&self.host_id)
        .bind(tag_id)
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
            && crate::work_sessions::can_claim_in(transaction, task).await?
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
        let candidates = sqlx::query("SELECT pending.task_id, pending.accepted_order FROM supertag_v2_tasks pending WHERE pending.state = $1 AND pending.accepted_order > $2 AND pending.harness_kind IN (0,$8) AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks active WHERE active.tag_id = pending.tag_id AND active.session_id = pending.session_id AND (active.state IN ($3,$4,$5) OR active.cleanup_pending = 1)) AND ($6 = 1 OR EXISTS (SELECT 1 FROM supertag_v2_host_tags scope WHERE scope.host_id=$7 AND scope.tag_id=pending.tag_id)) ORDER BY pending.accepted_order LIMIT 32")
            .bind(TaskState::Queued as i64).bind(after).bind(TaskState::Claimed as i64)
            .bind(TaskState::Running as i64).bind(TaskState::Uncertain as i64).bind(scope.all_tags).bind(&scope.host_id).bind(scope.harness as i64)
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
            && scope.serves(transaction, &task.tag_id).await?
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

pub(crate) fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn resolution_row(row: &AnyRow) -> Result<AttemptResolution> {
    let principal: String = row.try_get("operator_principal")?;
    let (operator_id, worker_host_id) = match (
        principal.strip_prefix("operator:"),
        principal.strip_prefix("host:"),
    ) {
        (Some(operator), _) => (operator, ""),
        (None, Some(host)) => ("", host),
        (None, None) => return Err(StoreError::PermissionDenied),
    };
    Ok(AttemptResolution {
        task_id: row.try_get("task_id")?,
        attempt_id: row.try_get("attempt_id")?,
        decision: row.try_get::<i64, _>("decision")? as i32,
        operator_id: operator_id.into(),
        evidence: row.try_get("evidence")?,
        resolved_at_ms: row.try_get("resolved_at_ms")?,
        worker_host_id: worker_host_id.into(),
    })
}
