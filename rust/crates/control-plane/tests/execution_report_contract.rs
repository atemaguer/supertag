//! The Task execution report's threshold and cleanup classifications, and the host's redacted
//! cleanup failure reasons (TypeScript `packages/control-plane/task-execution-report.test.ts`,
//! `tests/task-execution-report-recovery.test.ts`, and the second case of
//! `tests/durable-cleanup-unknown.test.ts`), on SQLite and PostgreSQL.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::{
    AppliedExecutionLimits, AttemptCleanup, AttemptDecision, ExecutionLimitEnforcement,
    ExecutionLimitOutcome, ExecutionLimits, ExecutionThreshold, FinishTaskRequest,
    InspectAttemptRequest, NativeTokenUsage, ObjectiveSignal, ReportAppliedLimitsRequest,
    ReportAttemptUsageRequest, ReportCleanupFailureRequest, ResolveAttemptRequest,
    StartTaskRequest, SubmitTaskRequest, Task, TaskExecutionReport, TaskState,
};
use uuid::Uuid;

const BASE: i64 = 1_790_000_000_000;
const LEASE: i64 = 30_000;

async fn submit(store: &Store, operation: &str, limit: Option<u64>) -> String {
    store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                execution_limits: limit.map(|limit| ExecutionLimits {
                    max_reported_tokens: Some(limit),
                    ..Default::default()
                }),
                tag_id: "worker".into(),
                session_id: operation.into(),
                operation_id: operation.into(),
                prompt: "Change the checkout".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task_id
}

async fn start(store: &Store, host: &HostAuthority, operation: &str) -> InspectAttemptRequest {
    let claim = store.claim_task(host, operation).await.unwrap().unwrap();
    let attempt = InspectAttemptRequest {
        task_id: claim.task.as_ref().unwrap().task_id.clone(),
        attempt_id: claim.attempt_id.clone(),
        lease_token: claim.lease_token.clone(),
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

async fn apply(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest, limit: u64) {
    store
        .report_applied_limits(
            host,
            &ReportAppliedLimitsRequest {
                attempt: Some(attempt.clone()),
                applied: Some(AppliedExecutionLimits {
                    limits: Some(ExecutionLimits {
                        max_reported_tokens: Some(limit),
                        ..Default::default()
                    }),
                    reported_tokens: ExecutionLimitEnforcement::InterruptOnReport.into(),
                    ..Default::default()
                }),
            },
        )
        .await
        .unwrap();
}

async fn used(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    sequence: u64,
    tokens: u64,
) {
    store
        .report_attempt_usage(
            host,
            &ReportAttemptUsageRequest {
                attempt: Some(attempt.clone()),
                sequence,
                native_usage: Some(NativeTokenUsage {
                    input_tokens: tokens,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                result: "Done".into(),
                succeeded: true,
                objective_signal: ObjectiveSignal::Progress.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

fn failure(attempt: &InspectAttemptRequest, reasons: &[&str]) -> ReportCleanupFailureRequest {
    ReportCleanupFailureRequest {
        attempt: Some(attempt.clone()),
        reasons: reasons.iter().map(|reason| (*reason).to_owned()).collect(),
    }
}

async fn report(store: &Store, task_id: &str) -> (Task, TaskExecutionReport) {
    let task = store.get_task(task_id).await.unwrap();
    let report = store.task_execution_report(&task).await.unwrap();
    (task, report)
}

async fn execution_report_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let observed = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || observed.load(Ordering::SeqCst));
    let host = support::register_host(&store, "laptop").await;
    let other = support::register_host(&store, "other").await;
    store.put_tag("worker", "Edit files", vec![]).await.unwrap();

    // Queued: no Attempt, and the requested limit is still to be applied.
    let first = submit(&store, "first", Some(100)).await;
    let (_, queued) = report(&store, &first).await;
    assert_eq!(queued.cleanup(), AttemptCleanup::NotStarted);
    assert_eq!(queued.limit_outcome(), ExecutionLimitOutcome::Pending);
    assert!(!queued.limits_applied && !queued.complete);

    // Running below the applied limit: pending; reaching it decides at once.
    let attempt = start(&store, &host, "first").await;
    apply(&store, &host, &attempt, 80).await;
    used(&store, &host, &attempt, 1, 50).await;
    let (_, running) = report(&store, &first).await;
    assert_eq!(running.cleanup(), AttemptCleanup::Pending);
    assert_eq!(running.limit_outcome(), ExecutionLimitOutcome::Pending);
    assert_eq!(
        running.max_reported_tokens(),
        ExecutionThreshold::Undetermined
    );
    assert!(running.limits_applied);
    assert_eq!(running.usage_complete, Some(false));
    used(&store, &host, &attempt, 2, 80).await;
    let (_, reached) = report(&store, &first).await;
    assert_eq!(
        reached.limit_outcome(),
        ExecutionLimitOutcome::ThresholdReached
    );
    assert_eq!(reached.max_reported_tokens(), ExecutionThreshold::Reached);

    // Finished by its host below the limit: within limits, complete, cleanup confirmed.
    let second = submit(&store, "second", Some(100)).await;
    let attempt = start(&store, &host, "second").await;
    apply(&store, &host, &attempt, 80).await;
    used(&store, &host, &attempt, 1, 50).await;
    // A cleanup failure the host later proves wrong is superseded by its Finish.
    store
        .report_cleanup_failure(&host, &failure(&attempt, &["guardian lost track"]))
        .await
        .unwrap();
    assert_eq!(
        report(&store, &second).await.1.cleanup(),
        AttemptCleanup::Unknown
    );
    finish(&store, &host, &attempt).await;
    let (task, within) = report(&store, &second).await;
    assert_eq!(task.state(), TaskState::Succeeded);
    assert_eq!(within.limit_outcome(), ExecutionLimitOutcome::WithinLimits);
    assert_eq!(within.max_reported_tokens(), ExecutionThreshold::NotReached);
    assert!(within.complete && within.usage_complete == Some(true));
    assert_eq!(within.cleanup(), AttemptCleanup::Confirmed);
    assert!(within.cleanup_failure.is_empty());
    // A settled Attempt takes no cleanup failure.
    assert!(matches!(
        store
            .report_cleanup_failure(&host, &failure(&attempt, &["late"]))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // A cleanup failure: only the claiming host with the lease token reports it, the reasons are
    // bounded, and the Control Plane hides explicit credentials the host did not know.
    let third = submit(&store, "third", Some(100)).await;
    let attempt = start(&store, &host, "third").await;
    apply(&store, &host, &attempt, 80).await;
    used(&store, &host, &attempt, 1, 50).await;
    let reasons = [
        "adapter process group did not stop",
        "stop https://user:hunter2-secret@sandbox.example.test/v1 refused",
    ];
    assert!(matches!(
        store
            .report_cleanup_failure(&other, &failure(&attempt, &reasons))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let forged = InspectAttemptRequest {
        lease_token: "forged".into(),
        ..attempt.clone()
    };
    assert!(matches!(
        store
            .report_cleanup_failure(&host, &failure(&forged, &reasons))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let long = "x".repeat(161);
    for invalid in [
        vec![],
        vec!["cause"; 9],
        vec![long.as_str()],
        vec!["two\nlines"],
        vec![" "],
    ] {
        assert!(matches!(
            store
                .report_cleanup_failure(&host, &failure(&attempt, &invalid))
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    store
        .report_cleanup_failure(&host, &failure(&attempt, &reasons))
        .await
        .unwrap();
    let (_, unknown) = report(&store, &third).await;
    assert_eq!(unknown.cleanup(), AttemptCleanup::Unknown);
    assert_eq!(
        unknown.cleanup_failure,
        [
            "adapter process group did not stop",
            "stop https://[REDACTED]@sandbox.example.test/v1 refused"
        ]
    );
    // The lease lapses; a restarted incarnation of the host replaces the reasons.
    clock.store(BASE + 3 * LEASE, Ordering::SeqCst);
    store.sweep_expired_attempts().await.unwrap();
    let record = store
        .register_host("laptop", "replacement-incarnation")
        .await
        .unwrap();
    let restarted = HostAuthority::new("host:laptop", record.generation).unwrap();
    store
        .report_cleanup_failure(
            &restarted,
            &failure(&attempt, &["sandbox termination could not be confirmed"]),
        )
        .await
        .unwrap();
    let (task, uncertain) = report(&store, &third).await;
    assert_eq!(task.state(), TaskState::Uncertain);
    assert_eq!(uncertain.cleanup(), AttemptCleanup::Unknown);
    assert_eq!(
        uncertain.cleanup_failure,
        ["sandbox termination could not be confirmed"]
    );
    // Its usage is not final, so the limits stay unknown.
    assert_eq!(uncertain.limit_outcome(), ExecutionLimitOutcome::Unknown);
    assert_eq!(uncertain.usage_complete, Some(false));
    // An operator's decision keeps the host's reasons: nothing proved cleanup.
    store
        .resolve_attempt(
            "operator:alice",
            &ResolveAttemptRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                operation_id: "resolve-third".into(),
                decision: AttemptDecision::Failed.into(),
                evidence: "checked the sandbox console".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    let (task, resolved) = report(&store, &third).await;
    assert_eq!(task.state(), TaskState::Failed);
    assert_eq!(resolved.cleanup(), AttemptCleanup::Unknown);
    assert_eq!(resolved.limit_outcome(), ExecutionLimitOutcome::Unknown);
    assert_eq!(resolved.cleanup_failure.len(), 1);

    // A Task without limits reports none, and a retry's new Attempt starts clean.
    let fourth = submit(&store, "fourth", None).await;
    let attempt = start(&store, &restarted, "fourth").await;
    store
        .report_cleanup_failure(&restarted, &failure(&attempt, &["guardian lost track"]))
        .await
        .unwrap();
    clock.store(BASE + 6 * LEASE, Ordering::SeqCst);
    store.sweep_expired_attempts().await.unwrap();
    store
        .resolve_attempt(
            "operator:alice",
            &ResolveAttemptRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                operation_id: "retry-fourth".into(),
                decision: AttemptDecision::Retry.into(),
                evidence: "checked the host".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    let (_, retried) = report(&store, &fourth).await;
    assert_eq!(retried.limit_outcome(), ExecutionLimitOutcome::NotRequested);
    assert_eq!(retried.cleanup(), AttemptCleanup::NotStarted);
    assert!(retried.cleanup_failure.is_empty() && retried.usage_complete.is_none());
    store.close().await;
}

#[tokio::test]
async fn sqlite_execution_report_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("report.db").display()
    );
    execution_report_contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_execution_report_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_report_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move {
            tokio::task::spawn_local(async move { execution_report_contract(url.as_str()).await })
                .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL execution report contract failed");
}
