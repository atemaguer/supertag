//! Pure Objective limit rules ported from the current TypeScript domain.
//!
//! Time and persisted observations are inputs; this module never reads a clock,
//! stores an Objective, sends a notice, or cancels execution. Controller/store
//! integration must record observations with revision checks, deduplicate notice
//! keys durably, and re-read exact Task/Attempt identities before applying stops.
//! As in the existing controller, sweeps select execution-started Objectives whose
//! status is neither Completed nor Cancelled; this module does not query candidates.

use std::{collections::BTreeMap, fmt};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

pub const MINUTE_MS: i64 = 60_000;
pub const BUDGET_WARNING_FRACTION: f64 = 0.8;
pub const DEADLINE_GRACE_MS: i64 = 15 * MINUTE_MS;

/// A validated UTC timestamp at the millisecond precision used by Objective notices.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct Timestamp(i64);

impl TryFrom<i64> for Timestamp {
    type Error = &'static str;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        Self::from_millis(value).ok_or("timestamp is outside the supported range")
    }
}

impl From<Timestamp> for i64 {
    fn from(value: Timestamp) -> Self {
        value.0
    }
}

impl Timestamp {
    pub fn from_millis(value: i64) -> Option<Self> {
        DateTime::<Utc>::from_timestamp_millis(value).map(|_| Self(value))
    }

    pub fn parse(value: &str) -> Result<Self, chrono::ParseError> {
        DateTime::parse_from_rfc3339(value).map(|time| Self(time.timestamp_millis()))
    }

    pub fn as_millis(self) -> i64 {
        self.0
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let time = DateTime::<Utc>::from_timestamp_millis(self.0)
            .expect("Timestamp constructors validate the timestamp range");
        formatter.write_str(&time.to_rfc3339_opts(SecondsFormat::Millis, true))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectiveStatus {
    Working,
    Blocked,
    Limited,
    ReadyForReview,
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ObjectiveLimits {
    pub status: ObjectiveStatus,
    pub created_at: Option<Timestamp>,
    pub deadline: Option<Timestamp>,
    pub budget_limit_minor: Option<u64>,
    pub budget_currency: Option<String>,
    pub paused_at: Option<Timestamp>,
    pub state: LimitState,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LimitState {
    pub summary: Option<Summary>,
    pub reported_spend: Option<SpendObservation>,
    pub budget_warnings: Vec<BudgetWarning>,
    pub budget_exhausted: Option<BudgetObservation>,
    pub deadline_set_at: Option<DeadlineObservation>,
    pub deadline_warnings: Vec<DeadlineWarning>,
    pub deadline_passed: Option<DeadlineObservation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    pub text: String,
    pub at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportedSpend {
    pub amount_minor: u64,
    pub currency: String,
    pub unknown_attempt_ids: Vec<String>,
    pub estimated_cost_attempts: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpendObservation {
    pub spend: ReportedSpend,
    pub observed_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BudgetWarning {
    pub fraction: f64,
    pub limit_minor: u64,
    pub spent_minor: u64,
    pub at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetObservation {
    pub limit_minor: u64,
    pub spent_minor: u64,
    pub at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeadlineObservation {
    pub deadline: Timestamp,
    pub at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeadlineWarning {
    pub minutes_before: i64,
    pub deadline: Timestamp,
    pub at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CostCoverage {
    NotApplicable,
    Pending,
    Complete,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptCostEvidence {
    pub attempt_id: String,
    pub coverage: CostCoverage,
    pub estimated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmissionBlocker {
    Cancelled,
    Completed,
    Limited,
    Paused,
    DeadlinePassed,
    BudgetExhausted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskPhase {
    Pending,
    Running { attempt_id: String },
    Settled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskObservation {
    pub task_id: String,
    pub phase: TaskPhase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    DeadlineGraceExpired,
    OwnerInactive,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StopTarget {
    pub task_id: String,
    pub attempt_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SweepDecision {
    pub state: LimitState,
    pub admission_blocker: Option<AdmissionBlocker>,
    pub stop_reason: Option<StopReason>,
    pub stop_targets: Vec<StopTarget>,
    /// Whether already observed Task settlement permits the transition to Limited.
    pub limit_now: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeKind {
    ObjectiveBudgetThreshold,
    ObjectiveBudgetExhausted,
    ObjectiveDeadlineSet,
    ObjectiveDeadlineApproaching,
    DeadlinePassed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    /// The controller scopes this stable key by Objective ID for durable deduplication.
    pub key: String,
    pub kind: NoticeKind,
    pub at: Timestamp,
    pub message: String,
}

pub fn has_reported_budget(objective: &ObjectiveLimits) -> bool {
    objective.budget_limit_minor.is_some() && objective.budget_currency.is_some()
}

fn budget_exhausted(objective: &ObjectiveLimits, state: &LimitState) -> bool {
    has_reported_budget(objective)
        && state
            .budget_exhausted
            .as_ref()
            .is_some_and(|entry| Some(entry.limit_minor) == objective.budget_limit_minor)
}

pub fn deadline_passed(objective: &ObjectiveLimits, now: Timestamp) -> bool {
    objective.deadline.is_some_and(|deadline| deadline <= now)
}

pub fn deadline_window_start(objective: &ObjectiveLimits) -> Option<Timestamp> {
    let deadline = objective.deadline?;
    objective
        .state
        .deadline_set_at
        .as_ref()
        .filter(|entry| entry.deadline == deadline)
        .map(|entry| entry.at)
        .or(objective.created_at)
}

pub fn deadline_grace_ms(objective: &ObjectiveLimits) -> i64 {
    let Some((deadline, start)) = objective.deadline.zip(deadline_window_start(objective)) else {
        return DEADLINE_GRACE_MS;
    };
    let window = deadline.0 - start.0;
    if window <= 0 {
        return DEADLINE_GRACE_MS;
    }
    (window / 4).clamp(MINUTE_MS, DEADLINE_GRACE_MS)
}

pub fn deadline_stops_running(
    objective: &ObjectiveLimits,
    now: Timestamp,
    grace_ms: Option<i64>,
) -> bool {
    objective.deadline.is_some_and(|deadline| {
        i128::from(deadline.0)
            + i128::from(grace_ms.unwrap_or_else(|| deadline_grace_ms(objective)))
            <= i128::from(now.0)
    })
}

pub fn deadline_warning_minutes(deadline: Timestamp, window_start: Timestamp) -> Vec<i64> {
    let window = deadline.0 - window_start.0;
    if window <= 0 {
        return vec![];
    }
    // Positive halves round up, as in Math.round(window * 0.25 / 60_000).
    let proportional = ((window + 2 * MINUTE_MS) / (4 * MINUTE_MS)).max(1);
    let mut minutes = vec![1_440, 60, proportional];
    minutes.retain(|offset| window > offset * MINUTE_MS);
    minutes.sort_unstable_by(|a, b| b.cmp(a));
    minutes.dedup();
    minutes
}

pub fn readable_duration(ms: i64) -> String {
    if ms < MINUTE_MS {
        return "less than a minute".into();
    }
    let minutes = (i128::from(ms) + i128::from(MINUTE_MS) / 2) / i128::from(MINUTE_MS);
    if minutes < 60 {
        return format!(
            "about {minutes} minute{}",
            if minutes == 1 { "" } else { "s" }
        );
    }
    let hours = (minutes + 30) / 60;
    if hours < 48 {
        return format!("about {hours} hour{}", if hours == 1 { "" } else { "s" });
    }
    format!("about {} days", (hours + 12) / 24)
}

pub fn admission_blocker(objective: &ObjectiveLimits, now: Timestamp) -> Option<AdmissionBlocker> {
    match objective.status {
        ObjectiveStatus::Cancelled => return Some(AdmissionBlocker::Cancelled),
        ObjectiveStatus::Completed => return Some(AdmissionBlocker::Completed),
        ObjectiveStatus::Limited => return Some(AdmissionBlocker::Limited),
        _ => {}
    }
    if objective.paused_at.is_some() {
        Some(AdmissionBlocker::Paused)
    } else if deadline_passed(objective, now) {
        Some(AdmissionBlocker::DeadlinePassed)
    } else if budget_exhausted(objective, &objective.state) {
        Some(AdmissionBlocker::BudgetExhausted)
    } else {
        None
    }
}

/// Select the existing budget report's total in the Objective currency. The caller must
/// aggregate each Attempt's latest cumulative usage once, not sum its usage updates.
pub fn reported_spend(
    objective: &ObjectiveLimits,
    observed_cost_by_currency: &BTreeMap<String, u64>,
    attempts: &[AttemptCostEvidence],
) -> Option<ReportedSpend> {
    let currency = objective
        .budget_currency
        .as_ref()
        .filter(|value| !value.is_empty())?;
    Some(ReportedSpend {
        amount_minor: observed_cost_by_currency
            .get(currency)
            .copied()
            .unwrap_or(0),
        currency: currency.clone(),
        unknown_attempt_ids: attempts
            .iter()
            .filter(|attempt| attempt.coverage == CostCoverage::Unknown)
            .map(|attempt| attempt.attempt_id.clone())
            .collect(),
        estimated_cost_attempts: attempts.iter().filter(|attempt| attempt.estimated).count(),
    })
}

/// Record each observation once against its current limit; changed limits discard stale evidence.
pub fn evaluate_limits(
    objective: &ObjectiveLimits,
    now: Timestamp,
    spend: Option<&ReportedSpend>,
) -> LimitState {
    let previous = &objective.state;
    let limit = objective
        .budget_limit_minor
        .filter(|_| has_reported_budget(objective));
    let mut state = LimitState {
        summary: previous.summary.clone(),
        budget_warnings: previous
            .budget_warnings
            .iter()
            .filter(|entry| Some(entry.limit_minor) == limit)
            .cloned()
            .collect(),
        budget_exhausted: previous
            .budget_exhausted
            .clone()
            .filter(|entry| Some(entry.limit_minor) == limit),
        deadline_set_at: previous
            .deadline_set_at
            .clone()
            .filter(|entry| Some(entry.deadline) == objective.deadline),
        deadline_warnings: previous
            .deadline_warnings
            .iter()
            .filter(|entry| Some(entry.deadline) == objective.deadline)
            .cloned()
            .collect(),
        deadline_passed: previous
            .deadline_passed
            .clone()
            .filter(|entry| Some(entry.deadline) == objective.deadline),
        ..LimitState::default()
    };
    if let (Some(limit), Some(spend)) = (limit, spend) {
        // Keep the TypeScript contract's IEEE-754 multiplication and ceiling at integer boundaries.
        let threshold = (BUDGET_WARNING_FRACTION * limit as f64).ceil() as u64;
        if spend.amount_minor >= threshold
            && !state
                .budget_warnings
                .iter()
                .any(|entry| entry.fraction == BUDGET_WARNING_FRACTION)
        {
            state.budget_warnings.push(BudgetWarning {
                fraction: BUDGET_WARNING_FRACTION,
                limit_minor: limit,
                spent_minor: spend.amount_minor,
                at: now,
            });
        }
        if state.budget_exhausted.is_none() && spend.amount_minor >= limit {
            state.budget_exhausted = Some(BudgetObservation {
                limit_minor: limit,
                spent_minor: spend.amount_minor,
                at: now,
            });
        }
        let mut spend = spend.clone();
        spend.unknown_attempt_ids.truncate(50);
        state.reported_spend = Some(SpendObservation {
            spend,
            observed_at: now,
        });
    }
    if let Some(deadline) = objective.deadline {
        if deadline > now {
            if let Some(start) = deadline_window_start(objective) {
                for minutes_before in deadline_warning_minutes(deadline, start) {
                    if deadline.0 - minutes_before * MINUTE_MS <= now.0
                        && !state
                            .deadline_warnings
                            .iter()
                            .any(|entry| entry.minutes_before == minutes_before)
                    {
                        state.deadline_warnings.push(DeadlineWarning {
                            minutes_before,
                            deadline,
                            at: now,
                        });
                    }
                }
            }
        } else if state.deadline_passed.is_none() {
            state.deadline_passed = Some(DeadlineObservation { deadline, at: now });
        }
    }
    state
}

/// A limit becomes a status only after the observed running Attempts have settled.
/// The caller supplies an eligible, execution-started, nonclosed Objective candidate.
pub fn should_limit(
    objective: &ObjectiveLimits,
    state: &LimitState,
    tasks: &[TaskObservation],
    now: Timestamp,
    grace_ms: Option<i64>,
) -> bool {
    objective.status != ObjectiveStatus::Limited
        && (budget_exhausted(objective, state) || deadline_stops_running(objective, now, grace_ms))
        && tasks
            .iter()
            .all(|task| !matches!(task.phase, TaskPhase::Running { .. }))
}

/// Plan one sweep without performing effects. `owner_active: None` means no owner was found,
/// which does not revoke authority. Each Task appears once in the caller's persisted snapshot.
///
/// Stop targets are requests, not evidence of cancellation. After stopping, the controller
/// must observe settlement before recomputing `should_limit`; a lost acknowledgement must
/// not turn a running Attempt into an imaginary settled one.
pub fn plan_sweep(
    objective: &ObjectiveLimits,
    now: Timestamp,
    spend: Option<&ReportedSpend>,
    tasks: &[TaskObservation],
    owner_active: Option<bool>,
    grace_ms: Option<i64>,
) -> SweepDecision {
    let state = evaluate_limits(objective, now, spend);
    let open = tasks
        .iter()
        .any(|task| !matches!(task.phase, TaskPhase::Settled));
    let stop_reason = if !open {
        None
    } else if deadline_stops_running(objective, now, grace_ms) {
        Some(StopReason::DeadlineGraceExpired)
    } else if owner_active == Some(false) {
        Some(StopReason::OwnerInactive)
    } else {
        None
    };
    let stop_targets = if stop_reason.is_some() {
        tasks
            .iter()
            .filter_map(|task| {
                let attempt_id = match &task.phase {
                    TaskPhase::Pending => None,
                    TaskPhase::Running { attempt_id } => Some(attempt_id.clone()),
                    TaskPhase::Settled => return None,
                };
                Some(StopTarget {
                    task_id: task.task_id.clone(),
                    attempt_id,
                })
            })
            .collect()
    } else {
        vec![]
    };
    let limit_now = should_limit(objective, &state, tasks, now, grace_ms);
    let updated = ObjectiveLimits {
        state: state.clone(),
        ..objective.clone()
    };
    SweepDecision {
        state,
        admission_blocker: admission_blocker(&updated, now),
        stop_reason,
        stop_targets,
        limit_now,
    }
}

pub fn limit_state_changed(previous: &LimitState, next: &LimitState) -> bool {
    let mut comparable = previous.clone();
    if let (Some(old), Some(new)) = (&mut comparable.reported_spend, &next.reported_spend) {
        old.observed_at = new.observed_at;
    }
    comparable != *next
}

pub fn deadline_warning_message(deadline: Timestamp, minutes_before: i64) -> String {
    format!(
        "The Objective deadline {deadline} is near: {} left.",
        readable_duration(minutes_before.saturating_mul(MINUTE_MS))
    )
}

fn grace_description(objective: &ObjectiveLimits) -> String {
    let readable = readable_duration(deadline_grace_ms(objective));
    readable
        .strip_prefix("about ")
        .unwrap_or(&readable)
        .to_owned()
}

pub fn deadline_set_message(
    deadline: Timestamp,
    at: Timestamp,
    previous: Option<Timestamp>,
) -> String {
    let action = match previous {
        Some(previous) => {
            format!("An operator moved the Objective deadline from {previous} to {deadline}")
        }
        None => format!("An operator set the Objective deadline to {deadline}"),
    };
    let left = deadline.0 - at.0;
    let description = if left > 0 {
        format!("{} left", readable_duration(left))
    } else {
        "it has already passed".into()
    };
    format!(
        "{action}: {description}. Deadline warnings now follow this deadline. Plan the remaining work to finish before it."
    )
}

/// Current limit events. Retrying returns the same keys; delivery owns durable deduplication.
pub fn limit_events(objective: &ObjectiveLimits) -> Vec<Notice> {
    let state = &objective.state;
    let unit = objective.budget_currency.as_deref().unwrap_or("");
    let mut notices = vec![];
    for entry in &state.budget_warnings {
        if Some(entry.limit_minor) == objective.budget_limit_minor {
            notices.push(Notice {
                key: format!("budget-threshold-{}-{}", entry.fraction, entry.limit_minor),
                kind: NoticeKind::ObjectiveBudgetThreshold,
                at: entry.at,
                message: format!("Provider-reported spend reached {}% of the Objective budget: {} of {} minor units of {unit}.", (entry.fraction * 100.0).round(), entry.spent_minor, entry.limit_minor),
            });
        }
    }
    if let Some(entry) = state
        .budget_exhausted
        .as_ref()
        .filter(|entry| Some(entry.limit_minor) == objective.budget_limit_minor)
    {
        notices.push(Notice {
            key: format!("budget-exhausted-{}", entry.limit_minor),
            kind: NoticeKind::ObjectiveBudgetExhausted,
            at: entry.at,
            message: format!("Provider-reported spend reached the Objective budget: {} of {} minor units of {unit}. New Tasks and continuations are refused; running Task Attempts finish, and cost beyond the limit is recorded as overrun.", entry.spent_minor, entry.limit_minor),
        });
    }
    for entry in &state.deadline_warnings {
        if Some(entry.deadline) == objective.deadline {
            notices.push(Notice {
                key: format!(
                    "deadline-approaching-{}-{}",
                    entry.minutes_before, entry.deadline
                ),
                kind: NoticeKind::ObjectiveDeadlineApproaching,
                at: entry.at,
                message: deadline_warning_message(entry.deadline, entry.minutes_before),
            });
        }
    }
    if let Some(entry) = state
        .deadline_passed
        .as_ref()
        .filter(|entry| Some(entry.deadline) == objective.deadline)
    {
        notices.push(Notice {
            key: format!("deadline-passed-{}", entry.deadline),
            kind: NoticeKind::DeadlinePassed,
            at: entry.at,
            message: format!("The Objective deadline {} passed. New Tasks and continuations are refused. Running Task Attempts may finish for {}, and the owner may still complete the Objective in that time.", entry.deadline, grace_description(objective)),
        });
    }
    notices
}

/// The current deadline's owner notices, oldest first. Old deadlines are inert.
pub fn deadline_notices(objective: &ObjectiveLimits) -> Vec<Notice> {
    let Some(deadline) = objective.deadline else {
        return vec![];
    };
    let state = &objective.state;
    let mut notices = vec![];
    if let Some(entry) = state
        .deadline_set_at
        .as_ref()
        .filter(|entry| entry.deadline == deadline)
    {
        notices.push(Notice {
            key: format!("deadline-set-{deadline}-{}", entry.at),
            kind: NoticeKind::ObjectiveDeadlineSet,
            at: entry.at,
            message: deadline_set_message(deadline, entry.at, None),
        });
    }
    for entry in &state.deadline_warnings {
        if entry.deadline == deadline {
            notices.push(Notice {
                key: format!("deadline-approaching-{}-{deadline}", entry.minutes_before),
                kind: NoticeKind::ObjectiveDeadlineApproaching,
                at: entry.at,
                message: deadline_warning_message(deadline, entry.minutes_before),
            });
        }
    }
    if let Some(entry) = state
        .deadline_passed
        .as_ref()
        .filter(|entry| entry.deadline == deadline)
    {
        notices.push(Notice {
            key: format!("deadline-passed-{deadline}"), kind: NoticeKind::DeadlinePassed, at: entry.at,
            message: format!("The Objective deadline {deadline} passed. New Tasks and continuations are refused. Complete the Objective now if its statement is satisfied; running Task Attempts keep authority for {}.", grace_description(objective)),
        });
    }
    notices.sort_by_key(|notice| notice.at);
    notices
}

/// The existing controller's delivery order: deadline-set notices, then current limit events.
pub fn notices_to_deliver(objective: &ObjectiveLimits) -> Vec<Notice> {
    if matches!(
        objective.status,
        ObjectiveStatus::Completed | ObjectiveStatus::Cancelled
    ) {
        return vec![];
    }
    deadline_notices(objective)
        .into_iter()
        .filter(|notice| notice.kind == NoticeKind::ObjectiveDeadlineSet)
        .chain(limit_events(objective))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minutes: i64) -> Timestamp {
        Timestamp::from_millis(1_893_456_000_000 + minutes * MINUTE_MS).unwrap()
    }

    fn objective() -> ObjectiveLimits {
        ObjectiveLimits {
            status: ObjectiveStatus::Working,
            created_at: Some(at(0)),
            deadline: None,
            budget_limit_minor: None,
            budget_currency: None,
            paused_at: None,
            state: LimitState::default(),
        }
    }

    fn spend(amount: u64) -> ReportedSpend {
        ReportedSpend {
            amount_minor: amount,
            currency: "USD".into(),
            unknown_attempt_ids: vec![],
            estimated_cost_attempts: 0,
        }
    }

    fn running(task: &str, attempt: &str) -> TaskObservation {
        TaskObservation {
            task_id: task.into(),
            phase: TaskPhase::Running {
                attempt_id: attempt.into(),
            },
        }
    }

    #[test]
    fn budget_warns_once_at_ceiling_of_eighty_percent_and_raise_resets_observations() {
        let mut subject = objective();
        subject.budget_limit_minor = Some(11);
        subject.budget_currency = Some("USD".into());
        let before = evaluate_limits(&subject, at(1), Some(&spend(8)));
        assert!(before.budget_warnings.is_empty());
        subject.state = evaluate_limits(&subject, at(2), Some(&spend(9)));
        assert_eq!(subject.state.budget_warnings.len(), 1);
        assert_eq!(subject.state.budget_warnings[0].spent_minor, 9);
        let first = subject.state.budget_warnings[0].clone();
        subject.state = evaluate_limits(&subject, at(3), Some(&spend(11)));
        assert_eq!(subject.state.budget_warnings, [first]);
        assert_eq!(
            admission_blocker(&subject, at(3)),
            Some(AdmissionBlocker::BudgetExhausted)
        );
        let exhausted = subject.state.budget_exhausted.clone();
        subject.state = evaluate_limits(&subject, at(4), Some(&spend(12)));
        assert_eq!(subject.state.budget_exhausted, exhausted);
        subject.budget_limit_minor = Some(100);
        assert_eq!(admission_blocker(&subject, at(5)), None);
        subject.state = evaluate_limits(&subject, at(5), Some(&spend(12)));
        assert!(subject.state.budget_warnings.is_empty());
        assert!(subject.state.budget_exhausted.is_none());
    }

    #[test]
    fn spent_budget_blocks_new_work_without_cancelling_running_attempts() {
        let mut subject = objective();
        subject.budget_limit_minor = Some(500);
        subject.budget_currency = Some("USD".into());
        let tasks = [running("starting-task", "attempt-1")];
        let decision = plan_sweep(&subject, at(1), Some(&spend(700)), &tasks, Some(true), None);
        assert_eq!(
            decision.admission_blocker,
            Some(AdmissionBlocker::BudgetExhausted)
        );
        assert!(decision.stop_targets.is_empty());
        assert!(!decision.limit_now);
        subject.state = decision.state;
        assert!(should_limit(&subject, &subject.state, &[], at(1), None));
        subject.status = ObjectiveStatus::Limited;
        assert!(!should_limit(&subject, &subject.state, &[], at(1), None));
    }

    #[test]
    fn allocation_only_budget_does_not_become_reported_money() {
        let mut subject = objective();
        subject.budget_limit_minor = Some(500);
        let state = evaluate_limits(&subject, at(1), Some(&spend(9_000)));
        assert_eq!(state, LimitState::default());
        assert_eq!(admission_blocker(&subject, at(1)), None);
    }

    #[test]
    fn deadline_warnings_follow_window_and_preserve_notice_ids() {
        let mut subject = objective();
        subject.deadline = Some(at(60));
        subject.state.deadline_set_at = Some(DeadlineObservation {
            deadline: at(60),
            at: at(0),
        });
        assert_eq!(deadline_warning_minutes(at(60), at(0)), [15]);
        assert!(
            evaluate_limits(&subject, at(44), None)
                .deadline_warnings
                .is_empty()
        );
        subject.state = evaluate_limits(&subject, at(45), None);
        assert_eq!(subject.state.deadline_warnings[0].minutes_before, 15);
        let events = limit_events(&subject);
        assert_eq!(
            events[0].key,
            "deadline-approaching-15-2030-01-01T01:00:00.000Z"
        );
        assert_eq!(
            events[0].message,
            "The Objective deadline 2030-01-01T01:00:00.000Z is near: about 15 minutes left."
        );
        let warnings = subject.state.deadline_warnings.clone();
        subject.state = evaluate_limits(&subject, at(46), None);
        assert_eq!(subject.state.deadline_warnings, warnings);
        assert_eq!(
            notices_to_deliver(&subject)[0].key,
            "deadline-set-2030-01-01T01:00:00.000Z-2030-01-01T00:00:00.000Z"
        );
        assert_eq!(deadline_warning_minutes(at(2_880), at(0)), [1_440, 720, 60]);
        assert_eq!(deadline_warning_minutes(at(5), at(0)), [1]);
        assert_eq!(deadline_warning_minutes(at(6), at(0)), [2]); // JS rounds positive halves up.
    }

    #[test]
    fn moved_deadline_ignores_old_observations_and_skips_already_due_warnings() {
        let mut subject = objective();
        subject.deadline = Some(at(5_760));
        subject.state.deadline_warnings = vec![DeadlineWarning {
            minutes_before: 1_440,
            deadline: at(1_440),
            at: at(1),
        }];
        subject.state.deadline_passed = Some(DeadlineObservation {
            deadline: at(1_440),
            at: at(1_441),
        });
        subject.state.deadline_set_at = Some(DeadlineObservation {
            deadline: at(5_760),
            at: at(5_040),
        });
        let state = evaluate_limits(&subject, at(5_730), None);
        assert!(state.deadline_passed.is_none());
        assert_eq!(
            state
                .deadline_warnings
                .iter()
                .map(|warning| warning.minutes_before)
                .collect::<Vec<_>>(),
            [180, 60]
        );
        subject.deadline = None;
        subject.state = state;
        let cleared = evaluate_limits(&subject, at(6_000), None);
        assert!(cleared.deadline_warnings.is_empty());
        assert!(cleared.deadline_set_at.is_none());
        assert!(cleared.deadline_passed.is_none());
    }

    #[test]
    fn grace_is_quarter_window_clamped_to_one_and_fifteen_minutes() {
        for (window, expected) in [(2_880, 15), (60, 15), (20, 5), (2, 1)] {
            let mut subject = objective();
            subject.deadline = Some(at(window));
            assert_eq!(deadline_grace_ms(&subject), expected * MINUTE_MS);
        }
        let mut subject = objective();
        subject.deadline = Some(at(620));
        subject.state.deadline_set_at = Some(DeadlineObservation {
            deadline: at(620),
            at: at(600),
        });
        assert_eq!(deadline_grace_ms(&subject), 5 * MINUTE_MS);
        assert!(!deadline_stops_running(&subject, at(624), None));
        assert!(deadline_stops_running(&subject, at(625), None));
        subject.state.deadline_set_at.as_mut().unwrap().at = at(621);
        assert_eq!(deadline_grace_ms(&subject), 15 * MINUTE_MS);
    }

    #[test]
    fn grace_expiry_targets_exact_work_and_notice_identities_then_waits_for_settlement() {
        let mut subject = objective();
        subject.deadline = Some(at(60));
        let tasks = [
            running("start", "start-attempt"),
            running("deadline-notice", "notice-attempt"),
            TaskObservation {
                task_id: "queued-notice".into(),
                phase: TaskPhase::Pending,
            },
            TaskObservation {
                task_id: "old-turn".into(),
                phase: TaskPhase::Settled,
            },
        ];
        let before = plan_sweep(&subject, at(74), None, &tasks, Some(true), None);
        assert_eq!(
            before.admission_blocker,
            Some(AdmissionBlocker::DeadlinePassed)
        );
        assert!(before.stop_targets.is_empty());
        assert!(!before.limit_now);
        let after = plan_sweep(&subject, at(75), None, &tasks, Some(true), None);
        assert_eq!(after.stop_reason, Some(StopReason::DeadlineGraceExpired));
        assert_eq!(
            after.stop_targets,
            [
                StopTarget {
                    task_id: "start".into(),
                    attempt_id: Some("start-attempt".into())
                },
                StopTarget {
                    task_id: "deadline-notice".into(),
                    attempt_id: Some("notice-attempt".into())
                },
                StopTarget {
                    task_id: "queued-notice".into(),
                    attempt_id: None
                }
            ]
        );
        assert_eq!(
            after
                .stop_targets
                .iter()
                .filter(|target| target.task_id == "start")
                .count(),
            1
        );
        assert!(!after.limit_now);
        assert!(should_limit(&subject, &after.state, &[], at(75), None));
    }

    #[test]
    fn admission_and_stop_precedence_match_current_behavior() {
        let mut subject = objective();
        subject.deadline = Some(at(1));
        subject.budget_limit_minor = Some(1);
        subject.budget_currency = Some("USD".into());
        subject.state = evaluate_limits(&subject, at(20), Some(&spend(1)));
        assert_eq!(
            admission_blocker(&subject, at(20)),
            Some(AdmissionBlocker::DeadlinePassed)
        );
        subject.paused_at = Some(at(0));
        assert_eq!(
            admission_blocker(&subject, at(20)),
            Some(AdmissionBlocker::Paused)
        );
        for (status, blocker) in [
            (ObjectiveStatus::Limited, AdmissionBlocker::Limited),
            (ObjectiveStatus::Completed, AdmissionBlocker::Completed),
            (ObjectiveStatus::Cancelled, AdmissionBlocker::Cancelled),
        ] {
            subject.status = status;
            assert_eq!(admission_blocker(&subject, at(20)), Some(blocker));
        }
        subject.status = ObjectiveStatus::Working;
        let tasks = [running("task", "attempt")];
        assert_eq!(
            plan_sweep(&subject, at(20), None, &tasks, Some(false), None).stop_reason,
            Some(StopReason::DeadlineGraceExpired)
        );
        subject.deadline = None;
        assert_eq!(
            plan_sweep(&subject, at(20), None, &tasks, Some(false), None).stop_reason,
            Some(StopReason::OwnerInactive)
        );
        assert!(
            plan_sweep(&subject, at(20), None, &tasks, None, None)
                .stop_targets
                .is_empty()
        );
        assert!(
            plan_sweep(&subject, at(20), None, &[], Some(false), None)
                .stop_targets
                .is_empty()
        );
    }

    #[test]
    fn spend_preserves_coverage_and_ignores_only_observation_time_for_changes() {
        let mut subject = objective();
        subject.budget_limit_minor = Some(10_000);
        subject.budget_currency = Some("USD".into());
        let amounts = BTreeMap::from([("USD".into(), 7_000), ("EUR".into(), 900)]);
        let mut attempts: Vec<_> = (0..55)
            .map(|n| AttemptCostEvidence {
                attempt_id: format!("a-{n}"),
                coverage: CostCoverage::Unknown,
                estimated: false,
            })
            .collect();
        attempts.push(AttemptCostEvidence {
            attempt_id: "estimate".into(),
            coverage: CostCoverage::Complete,
            estimated: true,
        });
        let spend = reported_spend(&subject, &amounts, &attempts).unwrap();
        assert_eq!(spend.amount_minor, 7_000);
        assert_eq!(spend.unknown_attempt_ids.len(), 55);
        assert_eq!(spend.estimated_cost_attempts, 1);
        let first = evaluate_limits(&subject, at(1), Some(&spend));
        assert_eq!(
            first
                .reported_spend
                .as_ref()
                .unwrap()
                .spend
                .unknown_attempt_ids
                .len(),
            50
        );
        subject.state = first.clone();
        let next = evaluate_limits(&subject, at(2), Some(&spend));
        assert!(!limit_state_changed(&first, &next));
        let changed = evaluate_limits(
            &subject,
            at(2),
            Some(&ReportedSpend {
                amount_minor: 7_001,
                ..spend
            }),
        );
        assert!(limit_state_changed(&first, &changed));
    }

    #[test]
    fn closed_objectives_emit_no_delivery_but_limit_notice_keys_are_stable() {
        let mut subject = objective();
        subject.deadline = Some(at(60));
        subject.budget_limit_minor = Some(500);
        subject.budget_currency = Some("USD".into());
        subject.state = evaluate_limits(&subject, at(61), Some(&spend(700)));
        assert_eq!(
            limit_events(&subject)
                .iter()
                .map(|notice| notice.key.as_str())
                .collect::<Vec<_>>(),
            [
                "budget-threshold-0.8-500",
                "budget-exhausted-500",
                "deadline-passed-2030-01-01T01:00:00.000Z"
            ]
        );
        let first_notices = notices_to_deliver(&subject);
        subject.state = evaluate_limits(&subject, at(62), Some(&spend(900)));
        assert_eq!(notices_to_deliver(&subject), first_notices);
        subject.status = ObjectiveStatus::Completed;
        assert!(notices_to_deliver(&subject).is_empty());
        subject.status = ObjectiveStatus::Cancelled;
        assert!(notices_to_deliver(&subject).is_empty());
    }

    #[test]
    fn zero_and_large_safe_integer_budgets_keep_legacy_threshold_boundaries() {
        let mut subject = objective();
        subject.budget_currency = Some("USD".into());
        subject.budget_limit_minor = Some(0);
        let state = evaluate_limits(&subject, at(1), Some(&spend(0)));
        assert_eq!(state.budget_warnings.len(), 1);
        assert_eq!(state.budget_exhausted.unwrap().spent_minor, 0);

        // The largest valid legacy budget is Number.MAX_SAFE_INTEGER. Keep its
        // Math.ceil(0.8 * limit) boundary, as well as the zero-budget boundary.
        subject.budget_limit_minor = Some(9_007_199_254_740_991);
        assert!(
            evaluate_limits(&subject, at(1), Some(&spend(7_205_759_403_792_792)))
                .budget_warnings
                .is_empty()
        );
        let threshold = evaluate_limits(&subject, at(1), Some(&spend(7_205_759_403_792_793)));
        assert_eq!(threshold.budget_warnings.len(), 1);
        assert!(threshold.budget_exhausted.is_none());
    }

    #[test]
    fn deadline_boundaries_are_inclusive_at_millisecond_precision() {
        let mut subject = objective();
        let deadline = Timestamp::from_millis(at(0).as_millis() + 480_007).unwrap();
        subject.deadline = Some(deadline);
        assert_eq!(deadline_grace_ms(&subject), 120_001); // floor(window / 4)
        let before = Timestamp::from_millis(deadline.as_millis() - 1).unwrap();
        assert!(!deadline_passed(&subject, before));
        assert!(deadline_passed(&subject, deadline));
        assert_eq!(
            evaluate_limits(&subject, deadline, None)
                .deadline_passed
                .unwrap()
                .at,
            deadline
        );
        assert!(!deadline_stops_running(&subject, before, Some(0)));
        assert!(deadline_stops_running(&subject, deadline, Some(0)));
        assert!(deadline_warning_minutes(at(0), at(0)).is_empty());
        assert!(deadline_warning_minutes(at(-1), at(0)).is_empty());
        subject.created_at = None;
        assert_eq!(deadline_grace_ms(&subject), DEADLINE_GRACE_MS);
        assert!(
            evaluate_limits(&subject, before, None)
                .deadline_warnings
                .is_empty()
        );
    }

    #[test]
    fn summary_survives_and_absent_spend_does_not_masquerade_as_fresh_evidence() {
        let mut subject = objective();
        subject.budget_limit_minor = Some(100);
        subject.budget_currency = Some("USD".into());
        subject.state.summary = Some(Summary {
            text: "Open work remains".into(),
            at: at(0),
        });
        subject.state = evaluate_limits(&subject, at(1), Some(&spend(90)));
        let next = evaluate_limits(&subject, at(2), None);
        assert_eq!(next.summary, subject.state.summary);
        assert_eq!(next.budget_warnings, subject.state.budget_warnings);
        assert!(next.reported_spend.is_none());
        assert!(limit_state_changed(&subject.state, &next));
        let empty_report = BTreeMap::new();
        assert_eq!(
            reported_spend(&subject, &empty_report, &[])
                .unwrap()
                .amount_minor,
            0
        );
        subject.budget_currency = None;
        assert!(reported_spend(&subject, &empty_report, &[]).is_none());
    }

    #[test]
    fn deadline_notices_keep_canonical_timestamps_order_and_owner_messages() {
        assert_eq!(
            Timestamp::parse("2029-12-31T16:00:00-08:00").unwrap(),
            at(0)
        );
        assert_eq!(
            Timestamp::parse("2030-01-01T00:00:00Z")
                .unwrap()
                .to_string(),
            "2030-01-01T00:00:00.000Z"
        );
        assert!(Timestamp::parse("not a date").is_err());
        for (duration, expected) in [
            (30_000, "less than a minute"),
            (60_000, "about 1 minute"),
            (90_000, "about 2 minutes"),
            (900_000, "about 15 minutes"),
            (3_600_000, "about 1 hour"),
            (43_200_000, "about 12 hours"),
            (259_200_000, "about 3 days"),
        ] {
            assert_eq!(readable_duration(duration), expected);
        }
        let mut subject = objective();
        subject.deadline = Some(at(20));
        subject.state.deadline_set_at = Some(DeadlineObservation {
            deadline: at(20),
            at: at(0),
        });
        subject.state = evaluate_limits(&subject, at(15), None);
        subject.state = evaluate_limits(&subject, at(20), None);
        let notices = deadline_notices(&subject);
        assert_eq!(
            notices.iter().map(|notice| notice.kind).collect::<Vec<_>>(),
            [
                NoticeKind::ObjectiveDeadlineSet,
                NoticeKind::ObjectiveDeadlineApproaching,
                NoticeKind::DeadlinePassed
            ]
        );
        assert!(
            notices[2]
                .message
                .ends_with("running Task Attempts keep authority for 5 minutes.")
        );
        assert!(deadline_set_message(at(20), at(0), Some(at(10))).starts_with("An operator moved the Objective deadline from 2030-01-01T00:10:00.000Z to 2030-01-01T00:20:00.000Z: about 20 minutes left."));
        assert!(deadline_set_message(at(0), at(0), None).contains("it has already passed"));
    }
}
