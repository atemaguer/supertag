mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::{
    AppliedExecutionLimits, Assignment, AttemptDecision, ExecutionLimitEnforcement,
    ExecutionLimits, FinishTaskRequest, InspectAttemptRequest, ObjectiveSignal,
    ReclaimAttemptRequest, ReportAppliedLimitsRequest, ResolveAttemptRequest, StartTaskRequest,
    SubmitTaskRequest, TaskState,
};
use uuid::Uuid;

const BASE: i64 = 1_790_000_000_000;
const LEASE: i64 = 30_000;

fn turn(operation_id: &str, session_id: &str, limited: bool) -> SubmitTaskRequest {
    SubmitTaskRequest {
        output_policy: None,
        execution_limits: limited.then(|| ExecutionLimits {
            max_reported_tokens: Some(100),
            ..Default::default()
        }),
        tag_id: "worker".into(),
        session_id: session_id.into(),
        operation_id: operation_id.into(),
        prompt: "Change the checkout".into(),
        input_artifacts: vec![],
    }
}

fn inspect(assignment: &Assignment) -> InspectAttemptRequest {
    InspectAttemptRequest {
        task_id: assignment.task.as_ref().unwrap().task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
    }
}

fn reclaim(attempt: &InspectAttemptRequest, evidence: &str) -> ReclaimAttemptRequest {
    ReclaimAttemptRequest {
        attempt: Some(attempt.clone()),
        evidence: evidence.into(),
    }
}

fn applied(limit: u64) -> ReportAppliedLimitsRequest {
    ReportAppliedLimitsRequest {
        attempt: None,
        applied: Some(AppliedExecutionLimits {
            limits: Some(ExecutionLimits {
                max_reported_tokens: Some(limit),
                ..Default::default()
            }),
            reported_tokens: ExecutionLimitEnforcement::InterruptOnReport.into(),
            ..Default::default()
        }),
    }
}

async fn running(
    store: &Store,
    host: &HostAuthority,
    operation: &str,
    session: &str,
    limited: bool,
) -> InspectAttemptRequest {
    store
        .submit_task("operator:alice", &turn(operation, session, limited))
        .await
        .unwrap();
    let claim = store.claim_task(host, operation).await.unwrap().unwrap();
    let attempt = inspect(&claim);
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

async fn reclaim_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let observed = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || observed.load(Ordering::SeqCst));
    let host = support::register_host(&store, "laptop").await;
    let other = support::register_host(&store, "other").await;
    store.put_tag("worker", "Edit files", vec![]).await.unwrap();

    // The adapter's confirmed limits join the Task execution report, once.
    let first = running(&store, &host, "first", "first", true).await;
    let report = |limit| ReportAppliedLimitsRequest {
        attempt: Some(first.clone()),
        ..applied(limit)
    };
    store
        .report_applied_limits(&host, &report(80))
        .await
        .unwrap();
    store
        .report_applied_limits(&host, &report(80))
        .await
        .unwrap();
    assert!(matches!(
        store.report_applied_limits(&host, &report(90)).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store.report_applied_limits(&other, &report(80)).await,
        Err(StoreError::PermissionDenied)
    ));
    let task = store.get_task(&first.task_id).await.unwrap();
    assert_eq!(task.applied_execution_limits, report(80).applied);
    assert_eq!(
        task.execution_limits.unwrap().max_reported_tokens,
        Some(100),
        "the requested limits stay beside the applied ones"
    );

    // Only the Attempt's own host, with its lease token, may reclaim it.
    let evidence = "every recorded process group is gone: 4242";
    assert!(matches!(
        store
            .reclaim_attempt(&other, &reclaim(&first, evidence))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let forged = InspectAttemptRequest {
        lease_token: "forged".into(),
        ..first.clone()
    };
    assert!(matches!(
        store
            .reclaim_attempt(&host, &reclaim(&forged, evidence))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.reclaim_attempt(&host, &reclaim(&first, " ")).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let resolution = store
        .reclaim_attempt(&host, &reclaim(&first, evidence))
        .await
        .unwrap();
    assert_eq!(resolution.decision(), AttemptDecision::Failed);
    assert_eq!(resolution.worker_host_id, "laptop");
    assert_eq!(resolution.operator_id, "");
    let task = store.get_task(&first.task_id).await.unwrap();
    assert_eq!(task.state(), TaskState::Failed);
    assert!(task.result.unwrap().contains("outcome is unknown"));
    assert_eq!(
        store
            .get_attempt_resolution(&host, &first)
            .await
            .unwrap()
            .unwrap(),
        resolution
    );
    // A lost answer is retried exactly; anything else keeps the first decision.
    assert_eq!(
        store
            .reclaim_attempt(&host, &reclaim(&first, evidence))
            .await
            .unwrap(),
        resolution
    );
    assert!(matches!(
        store
            .reclaim_attempt(&host, &reclaim(&first, "other evidence"))
            .await,
        Err(StoreError::Conflict(_))
    ));
    clock.store(BASE + LEASE, Ordering::SeqCst);
    assert!(matches!(
        store
            .resolve_attempt(
                "operator:alice",
                &ResolveAttemptRequest {
                    task_id: first.task_id.clone(),
                    attempt_id: first.attempt_id.clone(),
                    operation_id: "late-operator".into(),
                    decision: AttemptDecision::Retry.into(),
                    evidence: "checked".into(),
                    confirmed_stopped: true,
                },
            )
            .await,
        Err(StoreError::Conflict(message)) if message.contains("Worker Host laptop reclaimed")
    ));

    // A host that registers a new incarnation fences its old Attempt as uncertain; that host
    // still reclaims it once it proves the processes gone.
    let fenced = running(&store, &host, "fenced", "fenced", false).await;
    let record = store
        .register_host("laptop", "replacement-incarnation")
        .await
        .unwrap();
    let restarted = HostAuthority::new("host:laptop", record.generation).unwrap();
    assert_eq!(
        store.get_task(&fenced.task_id).await.unwrap().state(),
        TaskState::Uncertain
    );
    assert!(matches!(
        store
            .reclaim_attempt(&host, &reclaim(&fenced, evidence))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    store
        .reclaim_attempt(&restarted, &reclaim(&fenced, evidence))
        .await
        .unwrap();
    assert_eq!(
        store.get_task(&fenced.task_id).await.unwrap().state(),
        TaskState::Failed
    );

    // Cancellation stays authoritative; reclaim only completes its cleanup.
    let cancelled = running(&store, &restarted, "cancelled", "cancelled", false).await;
    store.cancel_task(&cancelled.task_id).await.unwrap();
    store
        .reclaim_attempt(&restarted, &reclaim(&cancelled, evidence))
        .await
        .unwrap();
    let cancelled = store.get_task(&cancelled.task_id).await.unwrap();
    assert_eq!(cancelled.state(), TaskState::Cancelled);
    assert!(
        !cancelled
            .result
            .as_deref()
            .unwrap_or_default()
            .contains("outcome is unknown"),
        "{cancelled:?}"
    );

    // A finished Attempt needs no recovery.
    let finished = running(&store, &restarted, "finished", "finished", false).await;
    store
        .finish_task(
            &restarted,
            &FinishTaskRequest {
                task_id: finished.task_id.clone(),
                attempt_id: finished.attempt_id.clone(),
                lease_token: finished.lease_token.clone(),
                result: "Done".into(),
                succeeded: true,
                objective_signal: ObjectiveSignal::Progress.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .reclaim_attempt(&restarted, &reclaim(&finished, evidence))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // An operator's retry wins; the next Attempt starts without the old applied limits.
    let retried = running(&store, &restarted, "retried", "retried", true).await;
    store
        .report_applied_limits(
            &restarted,
            &ReportAppliedLimitsRequest {
                attempt: Some(retried.clone()),
                ..applied(100)
            },
        )
        .await
        .unwrap();
    clock.store(BASE + 3 * LEASE, Ordering::SeqCst);
    store.sweep_expired_attempts().await.unwrap();
    store
        .resolve_attempt(
            "operator:alice",
            &ResolveAttemptRequest {
                task_id: retried.task_id.clone(),
                attempt_id: retried.attempt_id.clone(),
                operation_id: "retry".into(),
                decision: AttemptDecision::Retry.into(),
                evidence: "checked the host".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .reclaim_attempt(&restarted, &reclaim(&retried, evidence))
            .await,
        Err(StoreError::Conflict(_))
    ));
    let next = store
        .claim_task(&restarted, "retried-again")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.task.as_ref().unwrap().task_id, retried.task_id);
    assert!(
        store
            .get_task(&retried.task_id)
            .await
            .unwrap()
            .applied_execution_limits
            .is_none()
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_attempt_reclaim_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("reclaim.db").display()
    );
    reclaim_contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_attempt_reclaim_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_reclaim_{}", Uuid::new_v4().simple());
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
            tokio::task::spawn_local(async move { reclaim_contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL reclaim contract failed");
}
