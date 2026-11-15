//! The Task execution report's classifications, and the host's cleanup failure reasons.
//!
//! TypeScript parity: `taskExecutionLimitReport` and the `cleanup` and `cleanupFailure` fields of
//! `taskExecutionPlacementReport` (`packages/control-plane/src/task-execution-report.ts`), computed
//! only from durable records of the Task's current Attempt. The requested limits, the applied
//! limits, placement, and usage are reported by their own `Task` fields and `supertag task usage`.
//!
//! Differences: Rust hosts record no native subagent observations, so a positive native agent
//! limit stays undetermined (a zero limit is the Codex guard that disables subagents, so it is
//! not reached once the Attempt ends). Rust usage carries no completeness flag: usage is final
//! when the host itself finished the Attempt, since usage reports are accepted only while it
//! runs. An operator's audited `resolve-attempt --confirmed-stopped` counts as confirmed cleanup.
use sqlx::{Any, Pool, Row, any::AnyRow};
use supertag_protocol::{
    redaction::redact_text,
    v2::{
        AttemptCleanup, ExecutionLimitOutcome, ExecutionLimits, ExecutionThreshold,
        ReportCleanupFailureRequest, Task, TaskExecutionReport, TaskState,
    },
};

use crate::{
    Store, StoreError,
    store::{HostAuthority, Result, current_scope_in, invalid, lease_is_live, name},
    usage::{effective_total, usage_row},
};

/// TypeScript keeps at most eight cleanup causes of at most 160 characters each.
pub(crate) const MAX_REASONS: usize = 8;
pub(crate) const MAX_REASON_CHARS: usize = 160;

impl Store {
    /// The Task execution report of a Task's current Attempt, which `GetTask` adds to the Task.
    pub async fn task_execution_report(&self, task: &Task) -> Result<TaskExecutionReport> {
        name("Task ID", &task.task_id)?;
        let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
            .bind(&task.task_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
        report_for(&self.pool, &row, task, self.execution_now_ms()).await
    }

    /// Records why the host could not confirm the current Attempt's cleanup. The host redacts
    /// the values only it knows; the Control Plane also hides explicit credentials, such as URL
    /// userinfo. A later report replaces an earlier one.
    pub async fn report_cleanup_failure(
        &self,
        host: &HostAuthority,
        input: &ReportCleanupFailureRequest,
    ) -> Result<()> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Task Attempt is required"))?;
        if input.reasons.is_empty() || input.reasons.len() > MAX_REASONS {
            return Err(invalid("one to eight cleanup failure reasons are required"));
        }
        let mut reasons = Vec::with_capacity(input.reasons.len());
        for reason in &input.reasons {
            if reason.trim().is_empty()
                || reason.chars().count() > MAX_REASON_CHARS
                || reason.chars().any(char::is_control)
            {
                return Err(invalid(
                    "a cleanup failure reason must be one line of at most 160 characters",
                ));
            }
            reasons.push(bounded(&redact_text(reason, &[], true)));
        }
        name("Task ID", &attempt.task_id)?;
        name("Task Attempt ID", &attempt.attempt_id)?;
        name("lease token", &attempt.lease_token)?;
        let (mut transaction, _) = self.write().await?;
        current_scope_in(&mut transaction, host).await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
            .bind(&attempt.task_id)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
        // The claiming host, also a later incarnation of it that restarted on the same journal,
        // holding the Attempt's lease token.
        if row.try_get::<Option<String>, _>("attempt_id")?.as_deref()
            != Some(attempt.attempt_id.as_str())
            || row
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
        let state = row.try_get::<i64, _>("state")?;
        let pending = row.try_get::<i64, _>("cleanup_pending")? == 1;
        let unproven = row.try_get::<i64, _>("cleanup_observed")? == 0;
        let open = state == TaskState::Running as i64
            || state == TaskState::Uncertain as i64
            || (state == TaskState::Cancelled as i64 && pending);
        if !open || !unproven {
            return Err(StoreError::FailedPrecondition(
                "Task Attempt cleanup is already settled".into(),
            ));
        }
        sqlx::query("UPDATE supertag_v2_tasks SET cleanup_failure = $1 WHERE task_id = $2")
            .bind(serde_json::to_string(&reasons)?)
            .bind(&attempt.task_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }
}

fn bounded(text: &str) -> String {
    text.chars().take(MAX_REASON_CHARS).collect()
}

/// What an Attempt's durable records show; read once per report.
struct Observed {
    tokens: Option<u64>,
    cost: Option<(String, u64)>,
    /// The host itself finished or reclaimed the Attempt, so no usage report can follow.
    host_finished: bool,
}

/// The report for a Task row read by `GetTask`.
async fn report_for(
    pool: &Pool<Any>,
    row: &AnyRow,
    task: &Task,
    now: i64,
) -> Result<TaskExecutionReport> {
    let state = task.state();
    let pending = row.try_get::<i64, _>("cleanup_pending")? == 1;
    let observed_cleanup = row.try_get::<i64, _>("cleanup_observed")? == 1;
    let failure: Vec<String> = row
        .try_get::<Option<String>, _>("cleanup_failure")?
        .map(|value| serde_json::from_str(&value))
        .transpose()?
        .unwrap_or_default();
    let live = lease_is_live(row, now)?;
    let Some(attempt_id) = task.attempt_id.as_deref() else {
        return Ok(TaskExecutionReport {
            limit_outcome: if limited(task) {
                ExecutionLimitOutcome::Pending
            } else {
                ExecutionLimitOutcome::NotRequested
            } as i32,
            cleanup: AttemptCleanup::NotStarted as i32,
            limits_applied: task.execution_limits.as_ref().is_none_or(empty),
            complete: !limited(task),
            ..Default::default()
        });
    };
    let running = matches!(state, TaskState::Claimed | TaskState::Running);
    let cleanup = if !failure.is_empty() {
        AttemptCleanup::Unknown
    } else if observed_cleanup {
        AttemptCleanup::Confirmed
    } else if running || (state == TaskState::Cancelled && pending && live) {
        AttemptCleanup::Pending
    } else if !pending && state != TaskState::Uncertain {
        // StartTask was never accepted, so no native execution was authorized.
        AttemptCleanup::NotStarted
    } else {
        AttemptCleanup::Unknown
    };
    let resolved_by_operator: Option<String> = sqlx::query_scalar(
        "SELECT operator_principal FROM supertag_v2_attempt_resolutions WHERE attempt_id=$1",
    )
    .bind(attempt_id)
    .fetch_optional(pool)
    .await?;
    let observed = Observed {
        tokens: sqlx::query("SELECT * FROM supertag_v2_native_usage WHERE attempt_id=$1 ORDER BY sequence DESC LIMIT 1")
            .bind(attempt_id)
            .fetch_optional(pool)
            .await?
            .map(|row| usage_row(&row).and_then(|usage| effective_total(&usage)))
            .transpose()?,
        cost: sqlx::query("SELECT amount_minor, currency FROM supertag_v2_attempt_usage WHERE attempt_id=$1")
            .bind(attempt_id)
            .fetch_optional(pool)
            .await?
            .map(|row| -> Result<_> {
                Ok(row
                    .try_get::<Option<i64>, _>("amount_minor")?
                    .zip(row.try_get::<Option<String>, _>("currency")?)
                    .map(|(amount, currency)| (currency, amount.max(0) as u64)))
            })
            .transpose()?
            .flatten(),
        host_finished: observed_cleanup
            && failure.is_empty()
            && matches!(
                state,
                TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled
            )
            && resolved_by_operator
                .as_deref()
                .is_none_or(|principal| principal.starts_with("host:")),
    };
    let terminal = !(running || (state == TaskState::Cancelled && pending && live));
    let mut report = classify(task, &observed, terminal);
    report.cleanup = cleanup as i32;
    report.cleanup_failure = failure;
    Ok(report)
}

fn empty(limits: &ExecutionLimits) -> bool {
    limits.max_reported_tokens.is_none()
        && limits.max_reported_cost.is_none()
        && limits.max_native_agents.is_none()
}

fn limited(task: &Task) -> bool {
    task.execution_limits
        .as_ref()
        .is_some_and(|limits| !empty(limits))
        || task
            .applied_execution_limits
            .as_ref()
            .and_then(|applied| applied.limits.as_ref())
            .is_some_and(|limits| !empty(limits))
}

/// TypeScript's `taskExecutionLimitReport` outcome, thresholds, and completeness.
fn classify(task: &Task, observed: &Observed, terminal: bool) -> TaskExecutionReport {
    let requested = task.execution_limits.clone().unwrap_or_default();
    let applied = task
        .applied_execution_limits
        .as_ref()
        .and_then(|applied| applied.limits.clone());
    let applied_limits = applied.clone().unwrap_or_default();
    let limits_applied = empty(&requested)
        || applied.as_ref().is_some_and(|applied| {
            requested.max_native_agents.is_none_or(|limit| {
                applied
                    .max_native_agents
                    .is_some_and(|value| value <= limit)
            }) && requested.max_reported_tokens.is_none_or(|limit| {
                applied
                    .max_reported_tokens
                    .is_some_and(|value| value <= limit)
            }) && requested.max_reported_cost.as_ref().is_none_or(|limit| {
                applied.max_reported_cost.as_ref().is_some_and(|value| {
                    value.currency == limit.currency && value.amount_minor <= limit.amount_minor
                })
            })
        });
    let usage_relevant = requested.max_reported_tokens.is_some()
        || requested.max_reported_cost.is_some()
        || applied_limits.max_reported_tokens.is_some()
        || applied_limits.max_reported_cost.is_some();
    let usage_complete = terminal && observed.host_finished;
    let decided = |reached: bool, observed: bool| match (reached, terminal && observed) {
        (true, _) => Some(true),
        (false, true) => Some(false),
        (false, false) => None,
    };
    let native_agents = (requested.max_native_agents.is_some()
        || applied_limits.max_native_agents.is_some())
    .then(|| match applied_limits.max_native_agents {
        // The harness guard disables subagents; no Rust host reports a positive peak.
        Some(0) => decided(false, true),
        _ => None,
    });
    let tokens = (requested.max_reported_tokens.is_some()
        || applied_limits.max_reported_tokens.is_some())
    .then(|| {
        let limit = applied_limits.max_reported_tokens?;
        let used = observed.tokens?;
        decided(used >= limit, usage_complete)
    });
    let cost = (requested.max_reported_cost.is_some()
        || applied_limits.max_reported_cost.is_some())
    .then(|| {
        let limit = applied_limits.max_reported_cost.as_ref()?;
        let (currency, amount) = observed.cost.as_ref()?;
        if *currency != limit.currency {
            return None;
        }
        decided(*amount >= limit.amount_minor, usage_complete)
    });
    let outcomes = [native_agents, tokens, cost];
    let active: Vec<Option<bool>> = outcomes.iter().flatten().copied().collect();
    let complete =
        active.is_empty() || (terminal && limits_applied && active.iter().all(Option::is_some));
    let outcome = if active.is_empty() {
        ExecutionLimitOutcome::NotRequested
    } else if active.contains(&Some(true)) {
        ExecutionLimitOutcome::ThresholdReached
    } else if !terminal {
        ExecutionLimitOutcome::Pending
    } else if complete {
        ExecutionLimitOutcome::WithinLimits
    } else {
        ExecutionLimitOutcome::Unknown
    };
    let threshold = |value: Option<Option<bool>>| -> i32 {
        let threshold = match value {
            None => ExecutionThreshold::Unspecified,
            Some(None) => ExecutionThreshold::Undetermined,
            Some(Some(true)) => ExecutionThreshold::Reached,
            Some(Some(false)) => ExecutionThreshold::NotReached,
        };
        threshold as i32
    };
    TaskExecutionReport {
        limit_outcome: outcome as i32,
        max_reported_tokens: threshold(tokens),
        max_reported_cost: threshold(cost),
        max_native_agents: threshold(native_agents),
        limits_applied,
        usage_complete: usage_relevant.then_some(usage_complete),
        complete,
        cleanup: AttemptCleanup::Unspecified as i32,
        cleanup_failure: vec![],
    }
}

#[cfg(test)]
mod tests {
    use supertag_protocol::v2::{AppliedExecutionLimits, ReportedCostLimit};

    use super::*;

    fn task(requested: ExecutionLimits, applied: Option<ExecutionLimits>) -> Task {
        Task {
            execution_limits: Some(requested),
            applied_execution_limits: applied.map(|limits| AppliedExecutionLimits {
                limits: Some(limits),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn tokens(limit: u64) -> ExecutionLimits {
        ExecutionLimits {
            max_reported_tokens: Some(limit),
            ..Default::default()
        }
    }

    fn observed(tokens: Option<u64>, host_finished: bool) -> Observed {
        Observed {
            tokens,
            cost: None,
            host_finished,
        }
    }

    fn outcome(report: &TaskExecutionReport) -> ExecutionLimitOutcome {
        report.limit_outcome()
    }

    #[test]
    fn classifies_thresholds_as_typescript_does() {
        // No limits: nothing to classify, and the report is complete.
        let report = classify(&Task::default(), &observed(None, false), true);
        assert_eq!(outcome(&report), ExecutionLimitOutcome::NotRequested);
        assert!(report.complete && report.limits_applied && report.usage_complete.is_none());

        // Requested but not applied yet, while running: pending and undetermined.
        let running = classify(&task(tokens(100), None), &observed(Some(10), false), false);
        assert_eq!(outcome(&running), ExecutionLimitOutcome::Pending);
        assert_eq!(
            running.max_reported_tokens(),
            ExecutionThreshold::Undetermined
        );
        assert!(!running.limits_applied && !running.complete);

        // Reaching the applied limit is decided at once, even while running.
        let reached = classify(
            &task(tokens(100), Some(tokens(100))),
            &observed(Some(100), false),
            false,
        );
        assert_eq!(outcome(&reached), ExecutionLimitOutcome::ThresholdReached);
        assert_eq!(reached.max_reported_tokens(), ExecutionThreshold::Reached);

        // Ended below the limit with final usage: within limits and complete.
        let within = classify(
            &task(tokens(100), Some(tokens(80))),
            &observed(Some(50), true),
            true,
        );
        assert_eq!(outcome(&within), ExecutionLimitOutcome::WithinLimits);
        assert_eq!(within.max_reported_tokens(), ExecutionThreshold::NotReached);
        assert!(within.complete && within.limits_applied && within.usage_complete == Some(true));

        // Ended without final usage (an uncertain or resolved Attempt): unknown.
        let unknown = classify(
            &task(tokens(100), Some(tokens(100))),
            &observed(Some(50), false),
            true,
        );
        assert_eq!(outcome(&unknown), ExecutionLimitOutcome::Unknown);
        assert_eq!(unknown.usage_complete, Some(false));

        // An applied limit above the request is not applied completeness.
        let loose = classify(
            &task(tokens(100), Some(tokens(200))),
            &observed(Some(50), true),
            true,
        );
        assert!(!loose.limits_applied);
        assert_eq!(outcome(&loose), ExecutionLimitOutcome::Unknown);
    }

    #[test]
    fn cost_needs_the_applied_currency_and_native_agents_need_the_guard() {
        let cost = |currency: &str, amount: u64| ExecutionLimits {
            max_reported_cost: Some(ReportedCostLimit {
                currency: currency.into(),
                amount_minor: amount,
            }),
            ..Default::default()
        };
        let mut seen = observed(None, true);
        seen.cost = Some(("EUR".into(), 500));
        let other = classify(&task(cost("USD", 100), Some(cost("USD", 100))), &seen, true);
        assert_eq!(other.max_reported_cost(), ExecutionThreshold::Undetermined);
        seen.cost = Some(("USD".into(), 100));
        let reached = classify(&task(cost("USD", 100), Some(cost("USD", 100))), &seen, true);
        assert_eq!(reached.max_reported_cost(), ExecutionThreshold::Reached);

        let agents = |limit: u64| ExecutionLimits {
            max_native_agents: Some(limit),
            ..Default::default()
        };
        let disabled = classify(
            &task(agents(0), Some(agents(0))),
            &observed(None, true),
            true,
        );
        assert_eq!(disabled.max_native_agents(), ExecutionThreshold::NotReached);
        assert_eq!(outcome(&disabled), ExecutionLimitOutcome::WithinLimits);
        let positive = classify(
            &task(agents(2), Some(agents(2))),
            &observed(None, true),
            true,
        );
        assert_eq!(
            positive.max_native_agents(),
            ExecutionThreshold::Undetermined
        );
        assert_eq!(outcome(&positive), ExecutionLimitOutcome::Unknown);
    }
}
