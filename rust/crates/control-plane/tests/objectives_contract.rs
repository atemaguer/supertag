mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor, Row};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const BASE: i64 = 1_893_456_000_000;
const OPERATOR: &str = "operator:alice";

fn create(id: &str) -> CreateObjectiveRequest {
    CreateObjectiveRequest {
        objective_id: id.into(),
        operation_id: format!("create-{id}"),
        owner_tag_id: "owner".into(),
        outcome: "Deliver a tested change".into(),
        ongoing: false,
        deadline_ms: None,
        budget_limit_minor: None,
        budget_currency: None,
        team_id: None,
    }
}

fn action(id: &str, operation: &str) -> ObjectiveActionRequest {
    ObjectiveActionRequest {
        objective_id: id.into(),
        operation_id: operation.into(),
        reason: String::new(),
    }
}

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = Arc::clone(clock);
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

async fn claim_start(
    store: &Store,
    host: &HostAuthority,
    expected_task: &str,
) -> InspectAttemptRequest {
    let claim = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.as_ref().unwrap().task_id, expected_task);
    let identity = InspectAttemptRequest {
        task_id: expected_task.into(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: identity.task_id.clone(),
                attempt_id: identity.attempt_id.clone(),
                lease_token: identity.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    identity
}

fn finish(identity: &InspectAttemptRequest, signal: ObjectiveSignal) -> FinishTaskRequest {
    FinishTaskRequest {
        waiting_approval_ids: vec![],
        workspace_delivery: None,
        task_id: identity.task_id.clone(),
        attempt_id: identity.attempt_id.clone(),
        lease_token: identity.lease_token.clone(),
        result: "Verified result".into(),
        succeeded: true,
        objective_signal: signal as i32,
        checkpoint_sha256: None,
    }
}

async fn assert_no_claim(store: &Store, host: &HostAuthority) {
    assert!(
        store
            .claim_task(host, &Uuid::new_v4().to_string())
            .await
            .unwrap()
            .is_none()
    );
}

async fn seed_v3(url: &str) {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let migrations = if url.starts_with("sqlite:") {
        [
            include_str!("../migrations/sqlite/0001_initial.sql"),
            include_str!("../migrations/sqlite/0002_connector_outbox.sql"),
            include_str!("../migrations/sqlite/0003_execution_authority.sql"),
        ]
    } else {
        [
            include_str!("../migrations/postgresql/0001_initial.sql"),
            include_str!("../migrations/postgresql/0002_connector_outbox.sql"),
            include_str!("../migrations/postgresql/0003_execution_authority.sql"),
        ]
    };
    for migration in migrations {
        sqlx::raw_sql(migration)
            .execute(&mut connection)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision) VALUES ('prior','Original instructions','[]',1)").execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
}

async fn contract(url: String) {
    seed_v3(&url).await;
    let clock = Arc::new(AtomicI64::new(BASE));
    let store = open(&url, &clock).await;
    let host = support::register_host(&store, "worker").await;
    store
        .put_tag("owner", "Inspect the result", vec!["files:read".into()])
        .await
        .unwrap();
    let request = create("finite");
    let (one, two) = tokio::join!(
        store.create_objective(OPERATOR, &request),
        store.create_objective(OPERATOR, &request)
    );
    let objective = one.unwrap();
    assert_eq!(objective, two.unwrap());
    assert_eq!(objective.status, ObjectiveStatus::Working as i32);
    let starting = store.get_task(&objective.starting_task_id).await.unwrap();
    assert_eq!(starting.state, TaskState::Queued as i32);
    assert_eq!(starting.session_id, objective.session_id);
    assert_eq!(starting.allowed_actions, ["files:read"]);
    let mut changed = request.clone();
    changed.outcome = "Different work".into();
    assert!(matches!(
        store.create_objective(OPERATOR, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store.create_objective("host:forged", &request).await,
        Err(StoreError::PermissionDenied)
    ));
    store.close().await;

    let store = open(&url, &clock).await;
    assert_eq!(
        store.create_objective(OPERATOR, &request).await.unwrap(),
        objective
    );
    let paused = store
        .pause_objective(OPERATOR, &action("finite", "pause"))
        .await
        .unwrap();
    assert_eq!(paused.paused_at_ms, Some(BASE));
    assert_eq!(
        store
            .pause_objective(OPERATOR, &action("finite", "pause"))
            .await
            .unwrap(),
        paused
    );
    assert_no_claim(&store, &host).await;
    // A paused Objective cannot starve unrelated runnable work.
    let direct = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: "direct".into(),
                operation_id: "direct".into(),
                prompt: "Independent task".into(),
            },
        )
        .await
        .unwrap();
    let direct_attempt = claim_start(&store, &host, &direct.task_id).await;
    store
        .finish_task(&host, &finish(&direct_attempt, ObjectiveSignal::Progress))
        .await
        .unwrap();
    let resumed = store
        .resume_objective(OPERATOR, &action("finite", "resume"))
        .await
        .unwrap();
    assert!(resumed.paused_at_ms.is_none());
    assert_eq!(
        store
            .resume_objective(OPERATOR, &action("finite", "resume"))
            .await
            .unwrap(),
        resumed
    );
    let running = claim_start(&store, &host, &objective.starting_task_id).await;
    // Pause during execution leaves this exact Attempt running.
    store
        .pause_objective(OPERATOR, &action("finite", "pause-running"))
        .await
        .unwrap();
    assert_eq!(
        store.get_task(&running.task_id).await.unwrap().state,
        TaskState::Running as i32
    );
    let ready = finish(&running, ObjectiveSignal::ReadyForReview);
    store.finish_task(&host, &ready).await.unwrap();
    assert_eq!(
        store.get_objective("finite").await.unwrap().status,
        ObjectiveStatus::ReadyForReview as i32
    );
    store
        .resume_objective(OPERATOR, &action("finite", "resume-review"))
        .await
        .unwrap();
    let rejected = store
        .review_objective(
            OPERATOR,
            &ReviewObjectiveRequest {
                objective_id: "finite".into(),
                operation_id: "changes".into(),
                approved: false,
                feedback: "Add failure coverage".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(rejected.status, ObjectiveStatus::Working as i32);
    let cancelled = store
        .cancel_objective(OPERATOR, &action("finite", "cancel"))
        .await
        .unwrap();
    assert_eq!(cancelled.status, ObjectiveStatus::Cancelled as i32);
    assert_eq!(
        store
            .cancel_objective(OPERATOR, &action("finite", "cancel"))
            .await
            .unwrap(),
        cancelled
    );
    assert_no_claim(&store, &host).await;
    assert!(matches!(
        store
            .submit_task(
                OPERATOR,
                &SubmitTaskRequest {
                    tag_id: "owner".into(),
                    session_id: objective.session_id,
                    operation_id: "closed-bypass".into(),
                    prompt: "Cannot escape the closed Objective".into()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    let mut ongoing_input = create("ongoing");
    ongoing_input.ongoing = true;
    let ongoing = store
        .create_objective(OPERATOR, &ongoing_input)
        .await
        .unwrap();
    let identity = claim_start(&store, &host, &ongoing.starting_task_id).await;
    assert!(matches!(
        store
            .finish_task(&host, &finish(&identity, ObjectiveSignal::Completed))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert_eq!(
        store.get_task(&identity.task_id).await.unwrap().state,
        TaskState::Running as i32
    );
    store
        .finish_task(&host, &finish(&identity, ObjectiveSignal::ReadyForReview))
        .await
        .unwrap();
    let approval = ReviewObjectiveRequest {
        objective_id: "ongoing".into(),
        operation_id: "approve".into(),
        approved: true,
        feedback: "Operator ends the responsibility".into(),
    };
    let completed = store.review_objective(OPERATOR, &approval).await.unwrap();
    assert_eq!(completed.status, ObjectiveStatus::Completed as i32);
    assert_eq!(
        store.review_objective(OPERATOR, &approval).await.unwrap(),
        completed
    );

    let finite = store
        .create_objective(OPERATOR, &create("owner-completion"))
        .await
        .unwrap();
    let identity = claim_start(&store, &host, &finite.starting_task_id).await;
    let completion = finish(&identity, ObjectiveSignal::Completed);
    store.finish_task(&host, &completion).await.unwrap();
    assert_eq!(
        store
            .get_objective(&finite.objective_id)
            .await
            .unwrap()
            .status,
        ObjectiveStatus::Completed as i32
    );
    assert_eq!(
        store.finish_task(&host, &completion).await.unwrap().state,
        TaskState::Succeeded as i32
    );

    let mut budget_input = create("budget");
    budget_input.ongoing = true;
    budget_input.budget_limit_minor = Some(1_000);
    budget_input.budget_currency = Some("USD".into());
    let budget = store
        .create_objective(OPERATOR, &budget_input)
        .await
        .unwrap();
    let identity = claim_start(&store, &host, &budget.starting_task_id).await;
    let mut usage = ReportAttemptUsageRequest {
        attempt: Some(identity.clone()),
        sequence: 1,
        amount_minor: Some(500),
        currency: Some("USD".into()),
        estimated: false,
        native_usage: None,
    };
    store.report_attempt_usage(&host, &usage).await.unwrap();
    store.report_attempt_usage(&host, &usage).await.unwrap();
    let mut conflict = usage.clone();
    conflict.amount_minor = Some(501);
    assert!(matches!(
        store.report_attempt_usage(&host, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    let mut forged = usage.clone();
    forged.attempt.as_mut().unwrap().lease_token = "forged".into();
    assert!(matches!(
        store.report_attempt_usage(&host, &forged).await,
        Err(StoreError::PermissionDenied)
    ));
    usage.sequence = 2;
    usage.amount_minor = Some(700);
    store.report_attempt_usage(&host, &usage).await.unwrap();
    assert_eq!(
        store
            .get_objective("budget")
            .await
            .unwrap()
            .reported_spend_minor,
        Some(700)
    );
    usage.sequence = 3;
    usage.amount_minor = Some(1_200);
    store.report_attempt_usage(&host, &usage).await.unwrap();
    let exhausted = store.get_objective("budget").await.unwrap();
    assert_eq!(exhausted.reported_spend_minor, Some(1_200));
    assert_eq!(exhausted.status, ObjectiveStatus::Working as i32);
    assert_eq!(
        store
            .renew_attempt(&host, &identity)
            .await
            .unwrap()
            .valid_for_ms,
        30_000,
        "reported budget exhaustion does not revoke running authority"
    );
    assert_eq!(
        store.get_task(&identity.task_id).await.unwrap().state,
        TaskState::Running as i32
    );
    assert!(matches!(
        store
            .submit_task(
                OPERATOR,
                &SubmitTaskRequest {
                    tag_id: "owner".into(),
                    session_id: budget.session_id.clone(),
                    operation_id: "over-budget".into(),
                    prompt: "More work".into()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store
        .finish_task(&host, &finish(&identity, ObjectiveSignal::Progress))
        .await
        .unwrap();
    assert_eq!(
        store.get_objective("budget").await.unwrap().status,
        ObjectiveStatus::Limited as i32
    );
    store.close().await;

    let store = open(&url, &clock).await;
    store.report_attempt_usage(&host, &usage).await.unwrap(); // Exact durable evidence replay after settlement.
    let limited = store
        .pause_objective(OPERATOR, &action("budget", "pause-limited"))
        .await
        .unwrap();
    let raise = SetObjectiveLimitsRequest {
        objective_id: "budget".into(),
        operation_id: "raise".into(),
        budget_limit_minor: Some(2_000),
        expected_revision: Some(limited.revision),
        ..Default::default()
    };
    let resumed = store.set_objective_limits(OPERATOR, &raise).await.unwrap();
    assert_eq!(resumed.status, ObjectiveStatus::Working as i32);
    assert_eq!(resumed.paused_at_ms, Some(BASE));
    assert_no_claim(&store, &host).await;
    assert_eq!(
        store.set_objective_limits(OPERATOR, &raise).await.unwrap(),
        resumed
    );
    let stale = SetObjectiveLimitsRequest {
        operation_id: "stale-revision".into(),
        budget_limit_minor: Some(3_000),
        ..raise
    };
    assert!(matches!(
        store.set_objective_limits(OPERATOR, &stale).await,
        Err(StoreError::Conflict(_))
    ));
    store
        .cancel_objective(OPERATOR, &action("budget", "end-budget"))
        .await
        .unwrap();

    let mut deadline_input = create("deadline");
    deadline_input.ongoing = true;
    deadline_input.deadline_ms = Some(BASE + 120_000);
    let deadline = store
        .create_objective(OPERATOR, &deadline_input)
        .await
        .unwrap();
    let identity = claim_start(&store, &host, &deadline.starting_task_id).await;
    for elapsed in [20_000, 40_000, 60_000, 80_000, 100_000, 120_000] {
        clock.store(BASE + elapsed, Ordering::SeqCst);
        assert!(
            store
                .renew_attempt(&host, &identity)
                .await
                .unwrap()
                .valid_for_ms
                > 0
        );
    }
    store.sweep_objectives().await.unwrap();
    assert_eq!(
        store.get_task(&identity.task_id).await.unwrap().state,
        TaskState::Running as i32
    );
    assert!(matches!(
        store
            .submit_task(
                OPERATOR,
                &SubmitTaskRequest {
                    tag_id: "owner".into(),
                    session_id: deadline.session_id.clone(),
                    operation_id: "past-deadline".into(),
                    prompt: "New work".into()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    for (elapsed, expected_authority) in [(140_000, 30_000), (160_000, 20_000), (179_999, 1)] {
        clock.store(BASE + elapsed, Ordering::SeqCst);
        assert_eq!(
            store
                .renew_attempt(&host, &identity)
                .await
                .unwrap()
                .valid_for_ms,
            expected_authority
        );
    }
    // Finish arrives exactly when the capped lease expires. The Objective stop
    // wins over generic lease uncertainty, and this receipt confirms cleanup.
    clock.store(BASE + 180_000, Ordering::SeqCst);
    let after_cancel = store
        .finish_task(&host, &finish(&identity, ObjectiveSignal::Progress))
        .await
        .unwrap();
    assert_eq!(after_cancel.state, TaskState::Cancelled as i32);
    assert!(after_cancel.result.is_none());
    assert_eq!(
        store.get_objective("deadline").await.unwrap().status,
        ObjectiveStatus::Limited as i32
    );
    store.sweep_objectives().await.unwrap();
    assert_no_claim(&store, &host).await;
    store.close().await;

    let store = open(&url, &clock).await;
    let idle = store
        .create_objective(OPERATOR, &create("idle"))
        .await
        .unwrap();
    let first_attempt = claim_start(&store, &host, &idle.starting_task_id).await;
    let first_finish = finish(&first_attempt, ObjectiveSignal::Progress);
    store.finish_task(&host, &first_finish).await.unwrap();
    assert_eq!(
        store.get_objective("idle").await.unwrap().status,
        ObjectiveStatus::Working as i32
    );
    store.close().await;
    let store = open(&url, &clock).await;
    // A lost Finish response cannot enqueue a second idle continuation after restart.
    store.finish_task(&host, &first_finish).await.unwrap();
    let continuation = store
        .claim_task(&host, "idle-continuation")
        .await
        .unwrap()
        .unwrap();
    let second_task = continuation.task.unwrap();
    assert_ne!(second_task.task_id, idle.starting_task_id);
    assert!(
        second_task
            .prompt
            .contains("Your last turn ended with nothing running")
    );
    let second_attempt = InspectAttemptRequest {
        task_id: second_task.task_id,
        attempt_id: continuation.attempt_id,
        lease_token: continuation.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: second_attempt.task_id.clone(),
                attempt_id: second_attempt.attempt_id.clone(),
                lease_token: second_attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store
        .finish_task(&host, &finish(&second_attempt, ObjectiveSignal::Progress))
        .await
        .unwrap();
    assert_eq!(
        store.get_objective("idle").await.unwrap().status,
        ObjectiveStatus::Blocked as i32
    );
    assert_no_claim(&store, &host).await;
    let directed = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: idle.session_id,
                operation_id: "direct-idle-owner".into(),
                prompt: "Here is the missing decision".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store.get_objective("idle").await.unwrap().status,
        ObjectiveStatus::Working as i32
    );
    let directed_attempt = claim_start(&store, &host, &directed.task_id).await;
    store
        .finish_task(
            &host,
            &finish(&directed_attempt, ObjectiveSignal::Completed),
        )
        .await
        .unwrap();

    let mut ongoing_idle_input = create("ongoing-idle");
    ongoing_idle_input.ongoing = true;
    let ongoing_idle = store
        .create_objective(OPERATOR, &ongoing_idle_input)
        .await
        .unwrap();
    let ongoing_attempt = claim_start(&store, &host, &ongoing_idle.starting_task_id).await;
    store
        .finish_task(&host, &finish(&ongoing_attempt, ObjectiveSignal::Progress))
        .await
        .unwrap();
    assert_eq!(
        store.get_objective("ongoing-idle").await.unwrap().status,
        ObjectiveStatus::Working as i32
    );
    assert_no_claim(&store, &host).await;
    store
        .cancel_objective(OPERATOR, &action("ongoing-idle", "end-ongoing-idle"))
        .await
        .unwrap();

    let never_started = store
        .create_objective(OPERATOR, &create("never-started"))
        .await
        .unwrap();
    let unstarted_claim = store
        .claim_task(&host, "never-started-claim")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        unstarted_claim.task.unwrap().task_id,
        never_started.starting_task_id
    );
    store
        .cancel_objective(OPERATOR, &action("never-started", "end-unstarted"))
        .await
        .unwrap();
    let mut unknown_input = create("unknown-cost");
    unknown_input.ongoing = true;
    unknown_input.budget_limit_minor = Some(100);
    unknown_input.budget_currency = Some("USD".into());
    let unknown = store
        .create_objective(OPERATOR, &unknown_input)
        .await
        .unwrap();
    let unknown_attempt = claim_start(&store, &host, &unknown.starting_task_id).await;
    store
        .finish_task(&host, &finish(&unknown_attempt, ObjectiveSignal::Progress))
        .await
        .unwrap();
    assert_no_claim(&store, &host).await;
    store
        .cancel_objective(OPERATOR, &action("unknown-cost", "end-unknown"))
        .await
        .unwrap();
    store.close().await;

    let store = open(&url, &clock).await;
    let paused_race = store
        .create_objective(OPERATOR, &create("pause-race"))
        .await
        .unwrap();
    let reserved = store
        .claim_task(&host, "paused-reservation")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        reserved.task.as_ref().unwrap().task_id,
        paused_race.starting_task_id
    );
    let stale_start = StartTaskRequest {
        task_id: paused_race.starting_task_id.clone(),
        attempt_id: reserved.attempt_id.clone(),
        lease_token: reserved.lease_token,
    };
    store
        .pause_objective(OPERATOR, &action("pause-race", "pause-before-start"))
        .await
        .unwrap();
    assert!(matches!(
        store.start_task(&host, &stale_start).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let waiting = store.get_task(&paused_race.starting_task_id).await.unwrap();
    assert_eq!(waiting.state, TaskState::Queued as i32);
    assert!(waiting.attempt_id.is_none());
    assert!(
        store
            .claim_task(&host, "paused-reservation")
            .await
            .unwrap()
            .is_none()
    );
    let unrelated = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: "pause-race-unrelated".into(),
                operation_id: "pause-race-unrelated".into(),
                prompt: "Do other work while the Objective waits".into(),
            },
        )
        .await
        .unwrap();
    let other_attempt = claim_start(&store, &host, &unrelated.task_id).await;
    store
        .finish_task(&host, &finish(&other_attempt, ObjectiveSignal::Progress))
        .await
        .unwrap();
    // The clock has not advanced: retiring the reservation does not wait for its 30s lease.
    assert_eq!(clock.load(Ordering::SeqCst), BASE + 180_000);
    store.close().await;
    let store = open(&url, &clock).await;
    assert!(matches!(
        store.start_task(&host, &stale_start).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(
        store
            .claim_task(&host, "paused-reservation")
            .await
            .unwrap()
            .is_none()
    );
    store
        .resume_objective(OPERATOR, &action("pause-race", "resume-reservation"))
        .await
        .unwrap();
    let replacement = claim_start(&store, &host, &paused_race.starting_task_id).await;
    assert_ne!(replacement.attempt_id, reserved.attempt_id);
    assert!(matches!(
        store.start_task(&host, &stale_start).await,
        Err(StoreError::PermissionDenied)
    ));
    store
        .finish_task(&host, &finish(&replacement, ObjectiveSignal::Completed))
        .await
        .unwrap();
    assert_no_claim(&store, &host).await;
    store.close().await;

    let store = open(&url, &clock).await;
    let mut denied_input = create("denied-owner-signal");
    denied_input.ongoing = true;
    let denied = store
        .create_objective(OPERATOR, &denied_input)
        .await
        .unwrap();
    let denied_attempt = claim_start(&store, &host, &denied.starting_task_id).await;
    assert!(matches!(
        store
            .finish_task(&host, &finish(&denied_attempt, ObjectiveSignal::Completed))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut controlled_failure = finish(&denied_attempt, ObjectiveSignal::Progress);
    controlled_failure.succeeded = false;
    assert_eq!(
        store
            .finish_task(&host, &controlled_failure)
            .await
            .unwrap()
            .state,
        TaskState::Failed as i32
    );
    let after_denial = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: denied.session_id,
                operation_id: "after-denied-signal".into(),
                prompt: "Continue the ongoing responsibility".into(),
            },
        )
        .await
        .unwrap();
    let after_denial_attempt = claim_start(&store, &host, &after_denial.task_id).await;
    store
        .finish_task(
            &host,
            &finish(&after_denial_attempt, ObjectiveSignal::Progress),
        )
        .await
        .unwrap();
    store
        .cancel_objective(
            OPERATOR,
            &action("denied-owner-signal", "end-denied-signal"),
        )
        .await
        .unwrap();

    let mut recovery_input = create("failed-recovery");
    recovery_input.ongoing = true;
    let recovery = store
        .create_objective(OPERATOR, &recovery_input)
        .await
        .unwrap();
    let recovery_attempt = claim_start(&store, &host, &recovery.starting_task_id).await;
    let lost_finish = finish(&recovery_attempt, ObjectiveSignal::Progress);
    clock.store(BASE + 210_000, Ordering::SeqCst);
    assert_eq!(
        store.finish_task(&host, &lost_finish).await.unwrap().state,
        TaskState::Uncertain as i32
    );
    let resolve = ResolveAttemptRequest {
        task_id: recovery_attempt.task_id.clone(),
        attempt_id: recovery_attempt.attempt_id.clone(),
        operation_id: "resolve-failed".into(),
        decision: AttemptDecision::Failed as i32,
        confirmed_stopped: false,
        evidence: "The host confirmed cleanup; preserve the uncertain outcome as failed".into(),
    };
    let receipt = store.resolve_attempt(OPERATOR, &resolve).await.unwrap();
    store.close().await;
    let store = open(&url, &clock).await;
    assert!(matches!(
        store.finish_task(&host, &lost_finish).await,
        Err(StoreError::Conflict(_))
    ));
    assert_eq!(
        store
            .get_attempt_resolution(&host, &recovery_attempt)
            .await
            .unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        store.resolve_attempt(OPERATOR, &resolve).await.unwrap(),
        receipt
    );
    let after_recovery = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: recovery.session_id,
                operation_id: "after-failed-recovery".into(),
                prompt: "New work after explicit settlement".into(),
            },
        )
        .await
        .unwrap();
    let after_recovery_attempt = claim_start(&store, &host, &after_recovery.task_id).await;
    store
        .finish_task(
            &host,
            &finish(&after_recovery_attempt, ObjectiveSignal::Progress),
        )
        .await
        .unwrap();
    store
        .cancel_objective(OPERATOR, &action("failed-recovery", "end-failed-recovery"))
        .await
        .unwrap();

    let renew_base = clock.load(Ordering::SeqCst);
    let mut renew_input = create("renew-grace");
    renew_input.ongoing = true;
    renew_input.deadline_ms = Some(renew_base + 120_000);
    let renew_objective = store
        .create_objective(OPERATOR, &renew_input)
        .await
        .unwrap();
    let renew_attempt = claim_start(&store, &host, &renew_objective.starting_task_id).await;
    for elapsed in [
        20_000, 40_000, 60_000, 80_000, 100_000, 120_000, 140_000, 160_000, 170_000,
    ] {
        clock.store(renew_base + elapsed, Ordering::SeqCst);
        assert!(
            store
                .renew_attempt(&host, &renew_attempt)
                .await
                .unwrap()
                .valid_for_ms
                > 0
        );
    }
    store
        .finish_task(&host, &finish(&renew_attempt, ObjectiveSignal::Progress))
        .await
        .unwrap();
    let notice = store
        .claim_task(&host, "late-grace-notice")
        .await
        .unwrap()
        .unwrap();
    let notice_attempt = InspectAttemptRequest {
        task_id: notice.task.unwrap().task_id,
        attempt_id: notice.attempt_id,
        lease_token: notice.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: notice_attempt.task_id.clone(),
                attempt_id: notice_attempt.attempt_id.clone(),
                lease_token: notice_attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    let mut inspect = sqlx::AnyConnection::connect(&url).await.unwrap();
    let start_deadline: i64 =
        sqlx::query_scalar("SELECT lease_expires_at_ms FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(&notice_attempt.task_id)
            .fetch_one(&mut inspect)
            .await
            .unwrap();
    assert_eq!(
        start_deadline,
        renew_base + 180_000,
        "Start authority is capped for a notice launched during grace"
    );
    inspect.close().await.unwrap();
    assert_eq!(
        store
            .renew_attempt(&host, &notice_attempt)
            .await
            .unwrap()
            .valid_for_ms,
        10_000
    );
    clock.store(renew_base + 180_000, Ordering::SeqCst);
    let ended = store.renew_attempt(&host, &notice_attempt).await.unwrap();
    assert_eq!(ended.valid_for_ms, 0);
    assert_eq!(ended.task.unwrap().state, TaskState::Cancelled as i32);
    assert_eq!(
        store
            .finish_task(&host, &finish(&notice_attempt, ObjectiveSignal::Progress))
            .await
            .unwrap()
            .state,
        TaskState::Cancelled as i32
    );
    assert_eq!(
        store.get_objective("renew-grace").await.unwrap().status,
        ObjectiveStatus::Limited as i32
    );
    assert_no_claim(&store, &host).await;
    store.close().await;

    // Notices are distinct Tasks and are accepted once across all repeated sweeps/restarts.
    let mut connection = sqlx::AnyConnection::connect(&url).await.unwrap();
    let notices = sqlx::query("SELECT task_id,notice_key FROM supertag_v2_objective_notices WHERE objective_id='deadline'").fetch_all(&mut connection).await.unwrap();
    assert_eq!(
        notices.len(),
        3,
        "one set, approaching, and passed notice survive all sweeps and renewals"
    );
    assert!(notices.iter().any(|row| {
        row.get::<String, _>("notice_key")
            .starts_with("deadline-passed-")
    }));
    assert!(
        notices
            .iter()
            .all(|row| row.get::<String, _>("task_id") != identity.task_id)
    );
    let prior: String =
        sqlx::query_scalar("SELECT instructions FROM supertag_v2_tags WHERE tag_id='prior'")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    assert_eq!(prior, "Original instructions");
    let idle_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_objective_notices WHERE objective_id='idle' AND notice_key LIKE 'idle:%'").fetch_one(&mut connection).await.unwrap();
    assert_eq!(idle_count, 1);
    let unstarted_costs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_objective_usage WHERE objective_id='never-started'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(
        unstarted_costs, 0,
        "claims that never authorized execution are not unknown cost"
    );
    let unknown_state: String = sqlx::query_scalar(
        "SELECT limit_state FROM supertag_v2_objectives WHERE objective_id='unknown-cost'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    let state: supertag_control_plane::objective_limits::LimitState =
        serde_json::from_str(&unknown_state).unwrap();
    assert_eq!(
        state.reported_spend.unwrap().spend.unknown_attempt_ids,
        [unknown_attempt.attempt_id]
    );
    connection.close().await.unwrap();
    let store = open(&url, &clock).await;
    let all = store
        .list_objectives(&ListObjectivesRequest {
            limit: 100,
            after_id: String::new(),
        })
        .await
        .unwrap();
    assert_eq!(
        all.len(),
        12,
        "bounded responses cap pages even when a caller requests more"
    );
    let tail = store
        .list_objectives(&ListObjectivesRequest {
            limit: 100,
            after_id: all.last().unwrap().objective_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(tail.len(), 1);
    let page = store
        .list_objectives(&ListObjectivesRequest {
            limit: 2,
            after_id: all[1].objective_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(page, all[2..4]);
    store.close().await;
}

#[tokio::test]
async fn sqlite_objectives_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("state.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_objectives_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_objectives_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL Objective contract failed");
}
