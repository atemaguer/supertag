//! Objective completion, its report to the home thread, the operator overview,
//! and Team concurrency as the overview reports it (TS
//! `tests/objective-completion-report.test.ts`, `tests/objective-summary.test.ts`,
//! `packages/control-plane/objective-summary.test.ts`, `tests/objective-overview.test.ts`,
//! `tests/team-concurrency.test.ts`, `packages/control-plane/budget-notifications.test.ts`).
mod support;

use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const CONNECTOR: &str = "connector:slack-objectives";
const NOW: i64 = 1_893_456_000_000;
const HOME: &str = "1794470000.100000";

fn slack(id: &str, ts: &str, thread: &str, text: &str) -> AcceptSlackEventRequest {
    AcceptSlackEventRequest {
        account_id: "slack-objectives".into(),
        event_id: id.into(),
        team_id: "TTEAM1".into(),
        channel_id: "CCHANNEL1".into(),
        message_ts: ts.into(),
        thread_ts: thread.into(),
        prompt: text.into(),
        mention_tag_id: Some("owner".into()),
        actor_id: "UALICE1".into(),
    }
}

/// Starts an Objective from a new Slack thread; the thread becomes its home.
async fn surface_objective(store: &Store, thread: &str, outcome: &str) -> Objective {
    let before = all_objectives(store).await;
    store
        .accept_slack_event(
            CONNECTOR,
            &slack(
                &format!("Ev{thread}"),
                thread,
                thread,
                &format!("@SuperTag objective {outcome}"),
            ),
        )
        .await
        .unwrap();
    all_objectives(store)
        .await
        .into_iter()
        .find(|objective| !before.contains(objective))
        .expect("a new Objective")
}

async fn all_objectives(store: &Store) -> Vec<Objective> {
    store
        .list_objectives("operator:local", &ListObjectivesRequest::default())
        .await
        .unwrap()
}

async fn create(store: &Store, id: &str, team: Option<&str>, budget: Option<u64>) -> Objective {
    store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: format!("create-{id}"),
                objective_id: id.into(),
                owner_tag_id: "owner".into(),
                outcome: "Deliver a reviewed result".into(),
                team_id: team.map(Into::into),
                budget_limit_minor: budget,
                budget_currency: budget.map(|_| "USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn claim(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("a queued Task");
    assert_eq!(assignment.task.unwrap().task_id, expected);
    let attempt = InspectAttemptRequest {
        task_id: expected.into(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    attempt
}

async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    result: &str,
    signal: ObjectiveSignal,
) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: result.into(),
                objective_signal: signal as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// Replies queued for the home thread whose text contains `needle`.
async fn home_replies(url: &str, needle: &str) -> Vec<String> {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let texts: Vec<String> = sqlx::query_scalar(
        "SELECT text FROM supertag_v2_replies WHERE conversation_id='CCHANNEL1' ORDER BY ready_order",
    )
    .fetch_all(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
    texts
        .into_iter()
        .filter(|text| text.contains(needle))
        .collect()
}

async fn overview(store: &Store, id: &str) -> ObjectiveOverview {
    store
        .objective_overview(
            "operator:local",
            &GetObjectiveOverviewRequest {
                objective_id: id.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

fn complete(id: &str, operation: &str, summary: &str) -> CompleteObjectiveRequest {
    CompleteObjectiveRequest {
        objective_id: id.into(),
        operation_id: operation.into(),
        summary: summary.into(),
        expected_revision: None,
    }
}

/// The owner's completion posts its bounded summary once to the home thread;
/// approval posts the owner's assessment; an Objective without a home thread,
/// and an operator's own completion, post nothing.
async fn completion_reports(store: &Store, url: &str, host: &HostAuthority) {
    let shipped = surface_objective(store, HOME, "Ship the release").await;
    let starting = claim(store, host, &shipped.starting_task_id).await;
    let summary = format!("Released 1.0. {}", "x".repeat(2000));
    finish(store, host, &starting, &summary, ObjectiveSignal::Completed).await;
    let completed = store
        .get_objective("operator:local", &shipped.objective_id)
        .await
        .unwrap();
    assert_eq!(completed.status(), ObjectiveStatus::Completed);
    assert_eq!(
        completed.completion_summary.as_deref(),
        Some(summary.as_str())
    );
    let reports = home_replies(url, "is completed").await;
    assert_eq!(reports.len(), 1, "{reports:?}");
    let report = &reports[0];
    assert!(report.starts_with(&format!(
        "Objective {} is completed: Released 1.0.",
        shipped.objective_id
    )));
    assert!(report.chars().count() < 1600);
    assert!(report.ends_with('…'));
    // Nothing reports it again: a sweep, a refused second completion, or a read.
    store.sweep_objectives().await.unwrap();
    assert!(matches!(
        store
            .complete_objective(OPERATOR, &complete(&shipped.objective_id, "again", "Again"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(home_replies(url, "is completed").await.len(), 1);

    // Approval completes with the owner's submitted assessment and reports it.
    let thread = "1794470100.100000";
    let reviewed = surface_objective(store, thread, "Tidy the docs").await;
    let turn = claim(store, host, &reviewed.starting_task_id).await;
    finish(
        store,
        host,
        &turn,
        "Docs tidied; links checked.",
        ObjectiveSignal::ReadyForReview,
    )
    .await;
    let ready = overview(store, &reviewed.objective_id).await;
    assert_eq!(
        ready
            .objective
            .as_ref()
            .unwrap()
            .completion_summary
            .as_deref(),
        Some("Docs tidied; links checked.")
    );
    assert_eq!(
        ready.attention[0].next_actions[0],
        format!(
            "supertag objective review {} approve",
            reviewed.objective_id
        )
    );
    // Approval accepts the owner's assessment as it stands: feedback that would
    // replace it is refused and leaves the Objective waiting for review.
    assert!(matches!(
        store
            .review_objective(
                OPERATOR,
                &ReviewObjectiveRequest {
                    objective_id: reviewed.objective_id.clone(),
                    operation_id: "approve-docs-with-feedback".into(),
                    approved: true,
                    feedback: "Looks fine to me.".into(),
                },
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert_eq!(
        store
            .get_objective("operator:local", &reviewed.objective_id)
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::ReadyForReview
    );
    store
        .review_objective(
            OPERATOR,
            &ReviewObjectiveRequest {
                objective_id: reviewed.objective_id.clone(),
                operation_id: "approve-docs".into(),
                approved: true,
                feedback: String::new(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        home_replies(
            url,
            &format!("Objective {} is completed", reviewed.objective_id)
        )
        .await,
        vec![format!(
            "Objective {} is completed: Docs tidied; links checked.",
            reviewed.objective_id
        )]
    );

    // An operator's completion of a surface Objective changes it without reporting.
    let operated = surface_objective(store, "1794470200.100000", "Rotate keys").await;
    store
        .complete_objective(
            OPERATOR,
            &complete(
                &operated.objective_id,
                "complete-keys",
                "Keys rotated by hand.",
            ),
        )
        .await
        .unwrap();
    assert!(
        home_replies(
            url,
            &format!("Objective {} is completed", operated.objective_id)
        )
        .await
        .is_empty()
    );

    // An Objective without a home thread completes and reports nowhere.
    let before = home_replies(url, "").await.len();
    let quiet = create(store, "quiet", None, None).await;
    let quiet_turn = claim(store, host, &quiet.starting_task_id).await;
    finish(
        store,
        host,
        &quiet_turn,
        "Backlog tidied",
        ObjectiveSignal::Completed,
    )
    .await;
    assert_eq!(
        store
            .get_objective("operator:local", "quiet")
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::Completed
    );
    assert_eq!(home_replies(url, "").await.len(), before);
}

/// `supertag objective complete`: a required assessment, optimistic revision,
/// idempotent operation IDs, ongoing Objectives, and closed ones refused.
async fn operator_completion(store: &Store, host: &HostAuthority) {
    let objective = create(store, "operator-complete", None, None).await;
    let id = objective.objective_id.as_str();
    for blank in ["", "   \n"] {
        assert!(matches!(
            store
                .complete_objective(OPERATOR, &complete(id, "blank", blank))
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    let mut stale = complete(id, "stale", "Done");
    stale.expected_revision = Some(objective.revision + 5);
    assert!(matches!(
        store.complete_objective(OPERATOR, &stale).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .complete_objective("tag:owner", &complete(id, "tag", "Done"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let mut exact = complete(id, "complete", "  Verified the importer end to end.  ");
    exact.expected_revision = Some(objective.revision);
    let completed = store.complete_objective(OPERATOR, &exact).await.unwrap();
    assert_eq!(completed.status(), ObjectiveStatus::Completed);
    assert_eq!(
        completed.completion_summary.as_deref(),
        Some("Verified the importer end to end.")
    );
    // A lost response is retried with the same operation; different content conflicts.
    assert_eq!(
        store.complete_objective(OPERATOR, &exact).await.unwrap(),
        completed
    );
    let mut changed = exact.clone();
    changed.summary = "Something else".into();
    assert!(matches!(
        store.complete_objective(OPERATOR, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    // The open starting Task is cancelled; nothing of the Objective runs again.
    assert_eq!(
        store
            .get_task(&objective.starting_task_id)
            .await
            .unwrap()
            .state(),
        TaskState::Cancelled
    );
    // Get carries the summary; a list page leaves it out to stay bounded.
    assert_eq!(
        store
            .get_objective("operator:local", id)
            .await
            .unwrap()
            .completion_summary,
        completed.completion_summary
    );
    let listed = all_objectives(store).await;
    let listed = listed.iter().find(|o| o.objective_id == id).unwrap();
    assert_eq!(listed.completion_summary, None);
    assert_eq!(listed.status(), ObjectiveStatus::Completed);

    // Only an operator completes an ongoing responsibility.
    let ongoing = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "create-ongoing".into(),
                objective_id: "ongoing".into(),
                owner_tag_id: "owner".into(),
                outcome: "Keep the service healthy".into(),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let turn = claim(store, host, &ongoing.starting_task_id).await;
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: turn.task_id.clone(),
                attempt_id: turn.attempt_id.clone(),
                lease_token: turn.lease_token.clone(),
                succeeded: true,
                result: "All healthy".into(),
                objective_signal: ObjectiveSignal::Completed as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        store
            .complete_objective(
                OPERATOR,
                &complete("ongoing", "end", "Retired the service.")
            )
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::Completed
    );

    // A cancelled Objective stays cancelled.
    let cancelled = create(store, "cancelled", None, None).await;
    store
        .cancel_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: cancelled.objective_id.clone(),
                operation_id: "cancel".into(),
                reason: "Superseded".into(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .complete_objective(OPERATOR, &complete("cancelled", "late", "Done"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let view = overview(store, "cancelled").await;
    let record = view.objective.as_ref().unwrap();
    assert_eq!(record.cancellation_reason.as_deref(), Some("Superseded"));
    assert!(record.cancelled_at_ms.is_some());
    assert_eq!(
        view.attention
            .iter()
            .map(ObjectiveAttention::kind)
            .collect::<Vec<_>>(),
        [ObjectiveAttentionKind::Cancelled]
    );
}

/// The overview leads with the owner's Session, then every Work Session; it
/// reports one pool for all of them, what needs a person, Team posts, and
/// pages over every Task while keeping the totals.
async fn objective_overview(store: &Store, host: &HostAuthority, clock: &AtomicI64) {
    store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "team-delivery".into(),
                team_id: "delivery".into(),
                name: "delivery".into(),
                member_tag_ids: vec!["owner".into(), "helper".into()],
                max_concurrency: Some(2),
            },
        )
        .await
        .unwrap();
    let objective = create(store, "overview", Some("delivery"), Some(1000)).await;
    let id = objective.objective_id.as_str();
    let start = overview(store, id).await;
    assert_eq!(start.sessions.len(), 1);
    let owner = &start.sessions[0];
    assert!(owner.owner);
    assert_eq!(owner.status(), ObjectiveSessionStatus::Queued);
    assert_eq!(owner.latest_task_id, objective.starting_task_id);
    let team = start.team.as_ref().unwrap();
    assert_eq!(
        (team.name.as_str(), team.max_concurrency, team.running_turns),
        ("delivery", Some(2), 0)
    );
    assert_eq!(team.member_tag_ids, ["helper", "owner"]);
    let pool = start.pool.as_ref().unwrap();
    assert_eq!(pool.measure(), ObjectiveBudgetMeasure::ProviderReportedCost);
    assert_eq!(
        (pool.limit_minor, pool.spent_minor, pool.available_minor),
        (Some(1000), Some(0), Some(1000))
    );
    assert!(start.attention.is_empty(), "{:?}", start.attention);
    assert_eq!(start.conversation.len(), 1);
    assert_eq!(start.conversation[0].kind, "start");
    assert_eq!(start.total_tasks, 1);

    // The owner's turn runs, hands work to the helper, and reports cost.
    let turn = claim(store, host, &objective.starting_task_id).await;
    let running = overview(store, id).await;
    assert_eq!(
        running.sessions[0].status(),
        ObjectiveSessionStatus::Running
    );
    assert_eq!(running.team.as_ref().unwrap().running_turns, 1);
    let work = store
        .start_work_session(
            host,
            &StartWorkSessionRequest {
                attempt: Some(turn.clone()),
                operation_id: "build".into(),
                title: "Build the exporter".into(),
                instruction: "Write the exporter".into(),
                target_tag_id: Some("helper".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .post_attempt_workstream(
            host,
            &PostAttemptWorkstreamRequest {
                attempt: Some(turn.clone()),
                operation_id: "post".into(),
                body: "Exporter handed to helper.".into(),
                to_tag_ids: vec!["helper".into()],
            },
        )
        .await
        .unwrap();
    store
        .report_attempt_usage(
            host,
            &ReportAttemptUsageRequest {
                attempt: Some(turn.clone()),
                sequence: 1,
                native_usage: Some(NativeTokenUsage {
                    input_tokens: 10,
                    total_tokens: Some(10),
                    ..Default::default()
                }),
                amount_minor: Some(250),
                currency: Some("USD".into()),
                estimated: false,
            },
        )
        .await
        .unwrap();
    store
        .ask_question(
            host,
            &AskQuestionRequest {
                attempt: Some(turn.clone()),
                operation_id: "ask".into(),
                text: "Which region first?\u{1b}[2K".into(),
            },
        )
        .await
        .unwrap();
    finish(
        store,
        host,
        &turn,
        "Handing the build to the helper.",
        ObjectiveSignal::Progress,
    )
    .await;
    clock.fetch_add(60_000, Ordering::SeqCst);
    store.sweep_objectives().await.unwrap();

    let view = overview(store, id).await;
    assert_eq!(view.total_sessions, 2);
    assert_eq!(
        view.sessions
            .iter()
            .map(|session| (session.owner, session.tag_id.as_str()))
            .collect::<Vec<_>>(),
        [(true, "owner"), (false, "helper")]
    );
    let owner = &view.sessions[0];
    assert_eq!(owner.status(), ObjectiveSessionStatus::Waiting);
    assert_eq!(owner.question, "Which region first?\u{1b}[2K");
    let helper = &view.sessions[1];
    assert_eq!(helper.session_id, work.work_session_id);
    assert_eq!(helper.title, "Build the exporter");
    assert_eq!(helper.parent_session_id, objective.session_id);
    assert_eq!(helper.status(), ObjectiveSessionStatus::Queued);
    assert_eq!(helper.task_count, 1);
    let question = &view.attention[0];
    assert_eq!(question.kind(), ObjectiveAttentionKind::Question);
    assert_eq!(question.task_id, objective.starting_task_id);
    assert_eq!(
        question.next_actions,
        [format!(
            "supertag question answer {} TEXT",
            objective.starting_task_id
        )]
    );
    // One pool: the owner's reported cost counts against the Objective's budget.
    let pool = view.pool.as_ref().unwrap();
    assert_eq!(
        (pool.spent_minor, pool.available_minor, pool.overrun_minor),
        (Some(250), Some(750), 0)
    );
    assert_eq!(
        view.objective.as_ref().unwrap().reported_spend_minor,
        Some(250)
    );
    assert_eq!(view.conversation.len(), 1);
    assert_eq!(
        view.conversation[0].result,
        "Handing the build to the helper."
    );
    assert_eq!(
        view.posts
            .iter()
            .map(|post| (
                post.sequence,
                post.author_tag_id.as_str(),
                post.body.as_str()
            ))
            .collect::<Vec<_>>(),
        [(1, "owner", "Exporter handed to helper.")]
    );

    // Pages cover every Task of every Session while the totals stay whole.
    assert_eq!(view.total_tasks, 2);
    let first = store
        .objective_overview(
            "operator:local",
            &GetObjectiveOverviewRequest {
                objective_id: id.into(),
                limit: 1,
                offset: 0,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        first
            .tasks
            .iter()
            .map(|t| t.task_id.as_str())
            .collect::<Vec<_>>(),
        [objective.starting_task_id.as_str()]
    );
    assert_eq!(first.next_offset, Some(1));
    assert_eq!(first.conversation.len(), 1);
    assert_eq!(first.sessions.len(), 2);
    let second = store
        .objective_overview(
            "operator:local",
            &GetObjectiveOverviewRequest {
                objective_id: id.into(),
                limit: 1,
                offset: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(second.tasks.len(), 1);
    assert_eq!(second.tasks[0].kind, "work");
    assert_eq!(second.tasks[0].tag_id, "helper");
    assert_eq!(second.next_offset, None);

    // A paused Objective says how to resume it.
    store
        .pause_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: id.into(),
                operation_id: "pause".into(),
                reason: String::new(),
            },
        )
        .await
        .unwrap();
    let paused = overview(store, id).await;
    let item = paused
        .attention
        .iter()
        .find(|item| item.kind() == ObjectiveAttentionKind::Paused)
        .expect("paused attention");
    assert_eq!(
        item.next_actions,
        [format!("supertag objective resume {id}")]
    );

    // The overview is a read: it never changes the Objective.
    let revision = store
        .get_objective("operator:local", id)
        .await
        .unwrap()
        .revision;
    overview(store, id).await;
    assert_eq!(
        store
            .get_objective("operator:local", id)
            .await
            .unwrap()
            .revision,
        revision
    );
    assert!(matches!(
        store
            .objective_overview(
                "operator:local",
                &GetObjectiveOverviewRequest {
                    objective_id: "missing".into(),
                    ..Default::default()
                }
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
}

/// A reached budget is announced once in the Objective's home thread.
async fn budget_notice(store: &Store, url: &str, host: &HostAuthority) {
    let thread = "1794470300.100000";
    let objective = surface_objective(store, thread, "Benchmark the importer").await;
    let id = objective.objective_id.as_str();
    store
        .set_objective_limits(
            OPERATOR,
            &SetObjectiveLimitsRequest {
                objective_id: id.into(),
                operation_id: "budget".into(),
                budget_limit_minor: Some(100),
                budget_currency: Some("USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let turn = claim(store, host, &objective.starting_task_id).await;
    let usage = |sequence: u64, amount: u64| ReportAttemptUsageRequest {
        attempt: Some(turn.clone()),
        sequence,
        native_usage: Some(NativeTokenUsage {
            input_tokens: 10 * sequence,
            total_tokens: Some(10 * sequence),
            ..Default::default()
        }),
        amount_minor: Some(amount),
        currency: Some("USD".into()),
        estimated: false,
    };
    // The budget warning reaches the home thread before the budget runs out.
    store
        .report_attempt_usage(host, &usage(1, 80))
        .await
        .unwrap();
    store.sweep_objectives().await.unwrap();
    store.sweep_objectives().await.unwrap();
    let notices = home_replies(url, &format!("Objective {id:?}:")).await;
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(
        notices[0].contains("reached 80% of the Objective budget"),
        "{}",
        notices[0]
    );
    assert!(notices[0].contains(&format!("supertag describe objective {id}")));
    store
        .report_attempt_usage(host, &usage(2, 150))
        .await
        .unwrap();
    finish(
        store,
        host,
        &turn,
        "Benchmarked.",
        ObjectiveSignal::Progress,
    )
    .await;
    store.sweep_objectives().await.unwrap();
    store.sweep_objectives().await.unwrap();
    let notices = home_replies(url, &format!("Objective {id:?}:")).await;
    assert_eq!(notices.len(), 2, "{notices:?}");
    assert!(
        notices[1].contains("reached the Objective budget"),
        "{}",
        notices[1]
    );
    let view = overview(store, id).await;
    let pool = view.pool.as_ref().unwrap();
    assert!(pool.exhausted);
    assert_eq!(pool.overrun_minor, 50);
    assert_eq!(pool.available_minor, Some(-50));
    assert!(
        view.notices
            .iter()
            .any(|notice| notice.kind == "objective_budget_exhausted")
    );
}

/// An approaching and a passed deadline are each announced once in the home
/// thread; setting the deadline reaches only the owner (TS `objectiveLimitEvents`
/// through `BudgetNotifications`).
async fn deadline_notices(store: &Store, url: &str, clock: &AtomicI64) {
    let thread = "1794470400.100000";
    let objective = surface_objective(store, thread, "Cut the release branch").await;
    let id = objective.objective_id.as_str();
    let deadline = NOW + 2 * 60 * 60 * 1000;
    store
        .set_objective_limits(
            OPERATOR,
            &SetObjectiveLimitsRequest {
                objective_id: id.into(),
                operation_id: "deadline".into(),
                deadline_ms: Some(deadline),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store.sweep_objectives().await.unwrap();
    let needle = format!("Objective {id:?}:");
    let notices = || home_replies(url, &needle);
    assert!(notices().await.is_empty(), "{:?}", notices().await);

    // An hour before the deadline the thread hears how long is left.
    clock.store(deadline - 60 * 60 * 1000, Ordering::SeqCst);
    store.sweep_objectives().await.unwrap();
    store.sweep_objectives().await.unwrap();
    let posted = notices().await;
    assert_eq!(posted.len(), 1, "{posted:?}");
    assert!(
        posted[0].contains("is near: about 1 hour left."),
        "{}",
        posted[0]
    );
    assert!(posted[0].contains(&format!("supertag describe objective {id}")));

    // Once it passes the thread hears that new work is refused, once.
    clock.store(deadline + 1, Ordering::SeqCst);
    store.sweep_objectives().await.unwrap();
    store.sweep_objectives().await.unwrap();
    let posted = notices().await;
    assert!(
        posted
            .iter()
            .filter(|text| text.contains("passed. New Tasks and continuations are refused"))
            .count()
            == 1,
        "{posted:?}"
    );
    assert!(
        !posted
            .iter()
            .any(|text| text.contains("set the Objective deadline")),
        "{posted:?}"
    );
}

/// A report the home Tag can no longer accept is skipped; the completion it
/// reports still stands. The store refuses to retire a Tag that owns an open
/// Objective, so the test retires it directly to reach this defensive path.
async fn skipped_report(store: &Store, url: &str, host: &HostAuthority) {
    let objective = surface_objective(store, "1794470500.100000", "Archive the logs").await;
    let turn = claim(store, host, &objective.starting_task_id).await;
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    sqlx::query("UPDATE supertag_v2_tags SET retired_at_ms=$1 WHERE tag_id='owner'")
        .bind(NOW)
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    finish(
        store,
        host,
        &turn,
        "Logs archived.",
        ObjectiveSignal::Completed,
    )
    .await;
    assert_eq!(
        store
            .get_objective("operator:local", &objective.objective_id)
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::Completed
    );
    assert!(
        home_replies(
            url,
            &format!("Objective {} is completed", objective.objective_id)
        )
        .await
        .is_empty()
    );
}

/// Team concurrency counts every Objective naming the Team, and only those
/// (TS `tests/team-concurrency.test.ts`).
async fn team_concurrency(store: &Store, host: &HostAuthority) {
    let team = |id: &str, limit: Option<u32>| CreateTeamRequest {
        operation_id: format!("team-{id}"),
        team_id: id.into(),
        name: id.into(),
        member_tag_ids: vec!["owner".into()],
        max_concurrency: limit,
    };
    for (id, limit) in [("open", None), ("throttled", Some(1)), ("other", Some(1))] {
        store.create_team(OPERATOR, &team(id, limit)).await.unwrap();
    }
    // Without a limit, every Objective's turn runs at once.
    let mut open = vec![];
    for index in 0..3 {
        open.push(create(store, &format!("open-{index}"), Some("open"), None).await);
    }
    let mut running = vec![];
    for objective in &open {
        running.push(claim(store, host, &objective.starting_task_id).await);
    }
    let view = overview(store, "open-0").await;
    let team_view = view.team.as_ref().unwrap();
    assert_eq!(
        (team_view.max_concurrency, team_view.running_turns),
        (None, 3)
    );
    for attempt in &running {
        finish(store, host, attempt, "Done", ObjectiveSignal::Completed).await;
    }

    // A limit of one holds the second Objective's turn until the first ends.
    let here = create(store, "here", Some("throttled"), None).await;
    let elsewhere = create(store, "elsewhere", Some("throttled"), None).await;
    let first = claim(store, host, &here.starting_task_id).await;
    assert!(
        store
            .claim_task(host, "held-by-team")
            .await
            .unwrap()
            .is_none()
    );
    // Another Team's limit, and an Objective without a Team, are untouched by it.
    let unrelated = create(store, "unrelated", Some("other"), None).await;
    let teamless = create(store, "teamless", None, None).await;
    let unrelated_turn = claim(store, host, &unrelated.starting_task_id).await;
    let teamless_turn = claim(store, host, &teamless.starting_task_id).await;
    let view = overview(store, "here").await;
    let team_view = view.team.as_ref().unwrap();
    assert_eq!(
        (team_view.max_concurrency, team_view.running_turns),
        (Some(1), 1)
    );
    finish(store, host, &first, "Done", ObjectiveSignal::Completed).await;
    let second = claim(store, host, &elsewhere.starting_task_id).await;
    for attempt in [&second, &unrelated_turn, &teamless_turn] {
        finish(store, host, attempt, "Done", ObjectiveSignal::Completed).await;
    }
}

/// Each part runs on its own database so no part's queued Tasks reach another's claims.
async fn contract(url: String, part: usize) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = Arc::clone(&clock);
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    for id in ["owner", "helper"] {
        store
            .put_tag(id, "Deliver carefully", vec!["files:read".into()])
            .await
            .unwrap();
    }
    let host = support::register_host(&store, "worker").await;
    match part {
        0 => completion_reports(&store, &url, &host).await,
        1 => operator_completion(&store, &host).await,
        2 => objective_overview(&store, &host, &clock).await,
        3 => budget_notice(&store, &url, &host).await,
        4 => deadline_notices(&store, &url, &clock).await,
        5 => skipped_report(&store, &url, &host).await,
        _ => team_concurrency(&store, &host).await,
    }
    store.close().await;
}

const PARTS: usize = 7;

#[tokio::test]
async fn sqlite_objective_completion_and_overview() {
    for part in 0..PARTS {
        let dir = tempfile::tempdir().unwrap();
        contract(
            format!(
                "sqlite://{}?mode=rwc",
                dir.path().join("state.db").display()
            ),
            part,
        )
        .await;
    }
}

async fn on_postgres<F: Future<Output = ()> + 'static>(run: impl FnOnce(String) -> F) {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!(
        "supertag_rust_objective_overview_{}",
        Uuid::new_v4().simple()
    );
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(run(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL Objective completion and overview contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_objective_completion_and_overview() {
    for part in 0..PARTS {
        on_postgres(move |url| contract(url, part)).await;
    }
}
