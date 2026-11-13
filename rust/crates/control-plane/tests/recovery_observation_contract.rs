//! What an operator sees of Attempts that may have executed (`tests/ps-uncertain-attempts.test.ts`,
//! `tests/durable-cleanup-unknown.test.ts`): a host's status lists each Attempt that needs a
//! recovery decision, a cancelled Attempt whose cleanup is unconfirmed keeps its slot across a
//! Control Plane restart, and `GetMetrics` counts both and the decisions recorded for them.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const NOW: i64 = 1_893_456_000_000;
const OPERATOR: &str = "operator:alice";
/// Longer than an execution lease.
const LAPSE: i64 = 60_000;

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

fn report(sequence: u64) -> ReportHostRequest {
    ReportHostRequest {
        sequence,
        capacity: 2,
        available_slots: 2,
        readiness: HostReadiness::Ready as i32,
        reason: HostReadinessReason::Unspecified as i32,
        harness_kind: HarnessKind::Codex as i32,
        ..Default::default()
    }
}

/// Submit, claim and start one Task; returns its Task ID, Attempt ID and lease token.
async fn started(store: &Store, host: &HostAuthority, name: &str) -> (String, String, String) {
    let task = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "fixture".into(),
                session_id: format!("session-{name}"),
                operation_id: format!("submit-{name}"),
                prompt: format!("Run {name}"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let claim = store
        .claim_task(host, &format!("claim-{name}"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.as_ref().unwrap().task_id, task.task_id);
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: task.task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                lease_token: claim.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    (task.task_id, claim.attempt_id, claim.lease_token)
}

async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(&url, &clock).await;
    let host = support::register_host(&store, "laptop").await;
    store.put_tag("fixture", "Fixture", vec![]).await.unwrap();
    store.report_host(&host, &report(1)).await.unwrap();

    let (expired_task, expired_attempt, _) = started(&store, &host, "expired").await;
    let (cancelled_task, cancelled_attempt, _) = started(&store, &host, "cancelled").await;
    store.cancel_task(&cancelled_task).await.unwrap();
    // A next Task in each Session waits behind the running and the uncleaned Attempt.
    for name in ["expired", "cancelled"] {
        store
            .submit_task(
                OPERATOR,
                &SubmitTaskRequest {
                    tag_id: "fixture".into(),
                    session_id: format!("session-{name}"),
                    operation_id: format!("next-{name}"),
                    prompt: format!("Then {name}"),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }

    // A cancelled Attempt whose host has not confirmed cleanup holds its slot, also after a
    // Control Plane restart, but needs no decision while its lease is live.
    store.close().await;
    let store = open(&url, &clock).await;
    let status = store.get_host("laptop").await.unwrap();
    assert_eq!(status.active_attempts, 2);
    assert_eq!(status.available_slots, 0);
    assert!(status.uncertain_attempts.is_empty());
    let metrics = store.metrics().await.unwrap();
    let recovery = metrics.recovery.unwrap();
    assert_eq!(recovery.cleanup_unconfirmed, 1);
    assert_eq!(recovery.awaiting_decision, 0);
    assert_eq!(recovery.blocked_sessions, 2);
    assert_eq!(recovery.unknown_live_inputs, 0);
    let scheduling = metrics.scheduling.unwrap();
    assert_eq!(scheduling.placed_tasks, 2);
    assert_eq!(scheduling.started_attempts, 2);
    assert_eq!(scheduling.queued, 2);
    assert!(scheduling.oldest_queued_at_ms.is_some());
    // The execution clock measures claims, so the start waits are exact.
    assert_eq!(scheduling.maximum_start_wait_ms, 0);

    // Once both leases lapse, each is listed with the reason it needs a decision.
    clock.store(NOW + LAPSE, Ordering::SeqCst);
    store.sweep_expired_attempts().await.unwrap();
    let status = store.get_host("laptop").await.unwrap();
    assert_eq!(status.total_uncertain_attempts, 2);
    assert_eq!(
        status.active_attempts, 2,
        "uncertain Attempts keep their slots"
    );
    let listed: Vec<_> = status
        .uncertain_attempts
        .iter()
        .map(|attempt| {
            (
                attempt.task_id.clone(),
                attempt.attempt_id.clone(),
                attempt.cancelled,
                attempt.cleanup_observed,
                attempt.harness_kind(),
            )
        })
        .collect();
    assert!(listed.contains(&(
        expired_task.clone(),
        expired_attempt.clone(),
        false,
        false,
        HarnessKind::Unspecified
    )));
    assert!(listed.contains(&(
        cancelled_task.clone(),
        cancelled_attempt.clone(),
        true,
        false,
        HarnessKind::Unspecified
    )));
    for attempt in &status.uncertain_attempts {
        assert!(attempt.since_ms > NOW && attempt.since_ms <= NOW + LAPSE);
        assert!(attempt.reason.contains("not confirm"), "{}", attempt.reason);
    }
    // Every other host's view is unaffected.
    let other = support::register_host(&store, "other").await;
    store.report_host(&other, &report(1)).await.unwrap();
    assert!(
        store
            .get_host("other")
            .await
            .unwrap()
            .uncertain_attempts
            .is_empty()
    );
    let recovery = store.metrics().await.unwrap().recovery.unwrap();
    assert_eq!(recovery.awaiting_decision, 2);
    assert_eq!(recovery.cleanup_unconfirmed, 1);

    // The decisions the listed commands record free each slot and are counted.
    let resolve =
        |task: &str, attempt: &str, decision: AttemptDecision, id: &str| ResolveAttemptRequest {
            task_id: task.into(),
            attempt_id: attempt.into(),
            decision: decision as i32,
            evidence: "The process list shows nothing left.".into(),
            confirmed_stopped: true,
            operation_id: id.into(),
        };
    assert!(
        store
            .resolve_attempt(
                OPERATOR,
                &resolve(
                    &cancelled_task,
                    &cancelled_attempt,
                    AttemptDecision::Retry,
                    "retry-cancelled"
                )
            )
            .await
            .is_err(),
        "a cancelled Task is never retried by recovery"
    );
    store
        .resolve_attempt(
            OPERATOR,
            &resolve(
                &cancelled_task,
                &cancelled_attempt,
                AttemptDecision::Failed,
                "fail-cancelled",
            ),
        )
        .await
        .unwrap();
    store
        .resolve_attempt(
            OPERATOR,
            &resolve(
                &expired_task,
                &expired_attempt,
                AttemptDecision::Retry,
                "retry-expired",
            ),
        )
        .await
        .unwrap();
    let status = store.get_host("laptop").await.unwrap();
    assert!(status.uncertain_attempts.is_empty());
    assert_eq!(status.total_uncertain_attempts, 0);
    assert_eq!(status.active_attempts, 0);
    let metrics = store.metrics().await.unwrap();
    assert_eq!(
        metrics.recovery.unwrap(),
        MetricRecovery {
            awaiting_decision: 0,
            cleanup_unconfirmed: 0,
            resolved_failed: 1,
            resolved_retried: 1,
            blocked_sessions: 0,
            unknown_live_inputs: 0,
        }
    );
    // The retried Task waits again, with its original acceptance time.
    let scheduling = metrics.scheduling.unwrap();
    assert_eq!(scheduling.queued, 3);
    assert!(scheduling.oldest_queued_at_ms.is_some());
    store.close().await;
}

#[tokio::test]
async fn sqlite_uncertain_attempts_are_listed_counted_and_hold_their_slots() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("recovery.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_uncertain_attempts_are_listed_counted_and_hold_their_slots() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_recovery_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL recovery observation contract failed");
}
