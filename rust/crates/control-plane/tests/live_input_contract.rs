mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const NOW: i64 = 1_790_000_000_000;
const OPERATOR: &str = "operator:alice";

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

async fn submit(store: &Store, tag: &str, session: &str, operation: &str) -> Task {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: operation.into(),
                prompt: operation.into(),
            },
        )
        .await
        .unwrap()
}

async fn claim_start(store: &Store, host: &HostAuthority, task_id: &str) -> InspectAttemptRequest {
    let claim = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.unwrap().task_id, task_id);
    let attempt = InspectAttemptRequest {
        task_id: task_id.into(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
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

async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) -> Task {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                result: "Done".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

fn queue(task: &Task, operation: &str) -> QueueInputRequest {
    QueueInputRequest {
        task_id: task.task_id.clone(),
        operation_id: operation.into(),
        text: format!("Continue with {operation}"),
    }
}

fn take(attempt: &InspectAttemptRequest) -> TakeInputRequest {
    TakeInputRequest {
        attempt: Some(attempt.clone()),
    }
}

fn settle(
    attempt: &InspectAttemptRequest,
    input: &LiveInput,
    receipt: LiveInputReceipt,
) -> SettleInputRequest {
    SettleInputRequest {
        attempt: Some(attempt.clone()),
        input_id: input.input_id.clone(),
        receipt: receipt.into(),
    }
}

async fn ordered_receipts(store: &Store, host: &HostAuthority, other: &HostAuthority) {
    let target = submit(store, "reviewer", "ordered", "target").await;
    let request = queue(&target, "first");
    assert!(matches!(
        store.queue_input(OPERATOR, &request).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let attempt = claim_start(store, host, &target.task_id).await;
    let (one, replay) = tokio::join!(
        store.queue_input(OPERATOR, &request),
        store.queue_input(OPERATOR, &request)
    );
    let one = one.unwrap();
    assert_eq!(replay.unwrap(), one);
    assert!(matches!(
        store
            .queue_input(
                OPERATOR,
                &QueueInputRequest {
                    text: "Conflicting text".into(),
                    ..request.clone()
                }
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    let two = store
        .queue_input(OPERATOR, &queue(&target, "second"))
        .await
        .unwrap();
    let three = store
        .queue_input(OPERATOR, &queue(&target, "third"))
        .await
        .unwrap();
    assert!(one.order < two.order && two.order < three.order);

    let take_request = take(&attempt);
    let (first, duplicate) = tokio::join!(
        store.take_input_for_host(host, &take_request),
        store.take_input_for_host(host, &take_request)
    );
    let first = first.unwrap();
    let duplicate = duplicate.unwrap();
    assert_eq!(first.valid_for_ms + duplicate.valid_for_ms, 10_000);
    let returned = match (first.input, duplicate.input) {
        (Some(taken), None) | (None, Some(taken)) => taken,
        other => panic!("one dispatch must return the input: {other:?}"),
    };
    assert_eq!(returned.input_id, one.input_id);
    assert_eq!(returned.text, request.text);
    assert_eq!(returned.state(), LiveInputState::Dispatching);
    assert_eq!(store.get_input(&one.input_id).await.unwrap(), returned);
    let accepted = settle(&attempt, &one, LiveInputReceipt::Accepted);
    assert!(matches!(
        store.settle_input(other, &accepted).await,
        Err(StoreError::PermissionDenied)
    ));
    let first = store.settle_input(host, &accepted).await.unwrap();
    assert_eq!(first.state(), LiveInputState::Accepted);
    assert_eq!(store.settle_input(host, &accepted).await.unwrap(), first);
    let follower = store.get_task(&one.follower_task_id).await.unwrap();
    assert_eq!(follower.state(), TaskState::Succeeded);
    assert!(follower.attempt_id.is_none());

    let returned = store
        .take_input(host, &take_request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(returned.input_id, two.input_id);
    let unread = settle(&attempt, &two, LiveInputReceipt::Withdrawn);
    let withdrawn = store.settle_input(host, &unread).await.unwrap();
    assert_eq!(withdrawn.state(), LiveInputState::Withdrawn);
    assert_eq!(
        store
            .settle_input(host, &settle(&attempt, &two, LiveInputReceipt::Accepted))
            .await
            .unwrap(),
        withdrawn,
    );
    let withdrawn = store
        .settle_input(host, &settle(&attempt, &one, LiveInputReceipt::Withdrawn))
        .await
        .unwrap();
    assert_eq!(withdrawn.state(), LiveInputState::Withdrawn);
    assert!(
        store
            .take_input(host, &take_request)
            .await
            .unwrap()
            .is_none()
    );
    finish(store, host, &attempt).await;
    assert_eq!(
        store.queue_input(OPERATOR, &request).await.unwrap(),
        withdrawn
    );

    for input in [&one, &two, &three] {
        let fallback = claim_start(store, host, &input.follower_task_id).await;
        finish(store, host, &fallback).await;
    }
    assert_eq!(
        store.get_input(&three.input_id).await.unwrap().state(),
        LiveInputState::Rejected
    );

    let active = submit(store, "reviewer", "ordinary-first", "ordinary-active").await;
    let attempt = claim_start(store, host, &active.task_id).await;
    let ordinary = submit(store, "reviewer", "ordinary-first", "ordinary-queued").await;
    let pending = store
        .queue_input(OPERATOR, &queue(&active, "must-not-overtake"))
        .await
        .unwrap();
    assert!(
        store
            .take_input(host, &take(&attempt))
            .await
            .unwrap()
            .is_none()
    );
    finish(store, host, &attempt).await;
    let attempt = claim_start(store, host, &ordinary.task_id).await;
    finish(store, host, &attempt).await;
    let attempt = claim_start(store, host, &pending.follower_task_id).await;
    finish(store, host, &attempt).await;

    let target = submit(store, "reviewer", "rejected", "reject-target").await;
    let attempt = claim_start(store, host, &target.task_id).await;
    let input = store
        .queue_input(OPERATOR, &queue(&target, "rejected-input"))
        .await
        .unwrap();
    store
        .take_input(host, &take(&attempt))
        .await
        .unwrap()
        .unwrap();
    let receipt = settle(&attempt, &input, LiveInputReceipt::Rejected);
    let rejected = store.settle_input(host, &receipt).await.unwrap();
    assert_eq!(rejected.state(), LiveInputState::Rejected);
    assert_eq!(store.settle_input(host, &receipt).await.unwrap(), rejected);
    finish(store, host, &attempt).await;
    let attempt = claim_start(store, host, &input.follower_task_id).await;
    finish(store, host, &attempt).await;
}

async fn uncertain_delivery(url: &str, store: Store, clock: &Arc<AtomicI64>, host: &HostAuthority) {
    let target = submit(&store, "reviewer", "uncertain", "ambiguous-target").await;
    let attempt = claim_start(&store, host, &target.task_id).await;
    let input = store
        .queue_input(OPERATOR, &queue(&target, "lost-ack"))
        .await
        .unwrap();
    assert_eq!(
        store
            .take_input(host, &take(&attempt))
            .await
            .unwrap()
            .unwrap()
            .input_id,
        input.input_id
    );
    let queued = submit(&store, "reviewer", "uncertain", "blocked-later").await;
    let other = submit(&store, "other-tag", "uncertain", "independent-tag").await;
    assert_eq!(
        store.cancel_task(&target.task_id).await.unwrap().state(),
        TaskState::Cancelled
    );
    assert_eq!(
        finish(&store, host, &attempt).await.state(),
        TaskState::Cancelled
    );
    let other_attempt = claim_start(&store, host, &other.task_id).await;
    assert!(matches!(
        store
            .settle_input(
                host,
                &settle(&other_attempt, &input, LiveInputReceipt::Withdrawn)
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    finish(&store, host, &other_attempt).await;
    store.close().await;

    let store = open(url, clock).await;
    assert_eq!(
        store.get_input(&input.input_id).await.unwrap().state(),
        LiveInputState::Dispatching
    );
    assert!(
        store
            .take_input(host, &take(&attempt))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .claim_task(host, "waiting-for-recovery")
            .await
            .unwrap()
            .is_none()
    );
    clock.store(NOW + 10_000, Ordering::SeqCst);
    assert_eq!(store.sweep_inputs().await.unwrap(), 1);
    assert_eq!(
        store.get_input(&input.input_id).await.unwrap().state(),
        LiveInputState::Unknown
    );
    assert!(matches!(
        store
            .settle_input(host, &settle(&attempt, &input, LiveInputReceipt::Accepted))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let recovery = ResolveInputRequest {
        input_id: input.input_id.clone(),
        operation_id: "retry-verified-unread".into(),
        decision: LiveInputDecision::Retry.into(),
        evidence: "The native execution log confirms this input was unread".into(),
    };
    let recovered = store.resolve_input(OPERATOR, &recovery).await.unwrap();
    assert_eq!(recovered.state(), LiveInputState::Retried);
    assert_eq!(
        store.resolve_input(OPERATOR, &recovery).await.unwrap(),
        recovered
    );
    assert!(matches!(
        store
            .resolve_input(
                OPERATOR,
                &ResolveInputRequest {
                    evidence: "Changed evidence".into(),
                    ..recovery
                }
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .settle_input(host, &settle(&attempt, &input, LiveInputReceipt::Withdrawn))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let fallback = claim_start(&store, host, &input.follower_task_id).await;
    finish(&store, host, &fallback).await;
    let next = claim_start(&store, host, &queued.task_id).await;
    finish(&store, host, &next).await;

    let target = submit(&store, "reviewer", "in-flight", "receipt-after-finish").await;
    let attempt = claim_start(&store, host, &target.task_id).await;
    let input = store
        .queue_input(OPERATOR, &queue(&target, "late-but-live-ack"))
        .await
        .unwrap();
    store
        .take_input(host, &take(&attempt))
        .await
        .unwrap()
        .unwrap();
    finish(&store, host, &attempt).await;
    assert_eq!(
        store
            .settle_input(host, &settle(&attempt, &input, LiveInputReceipt::Accepted))
            .await
            .unwrap()
            .state(),
        LiveInputState::Accepted,
    );

    let target = submit(&store, "reviewer", "unread", "unread-target").await;
    let attempt = claim_start(&store, host, &target.task_id).await;
    let input = store
        .queue_input(OPERATOR, &queue(&target, "unread-native"))
        .await
        .unwrap();
    store
        .take_input(host, &take(&attempt))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        store
            .settle_input(host, &settle(&attempt, &input, LiveInputReceipt::Unknown))
            .await
            .unwrap()
            .state(),
        LiveInputState::Unknown,
    );
    assert_eq!(
        store
            .settle_input(host, &settle(&attempt, &input, LiveInputReceipt::Withdrawn))
            .await
            .unwrap()
            .state(),
        LiveInputState::Withdrawn,
    );
    finish(&store, host, &attempt).await;
    let fallback = claim_start(&store, host, &input.follower_task_id).await;
    finish(&store, host, &fallback).await;

    let target = submit(&store, "reviewer", "fenced", "fenced-target").await;
    let attempt = claim_start(&store, host, &target.task_id).await;
    let input = store
        .queue_input(OPERATOR, &queue(&target, "fenced-input"))
        .await
        .unwrap();
    store
        .take_input(host, &take(&attempt))
        .await
        .unwrap()
        .unwrap();
    let replacement = store
        .register_host("input-host", "replacement")
        .await
        .unwrap();
    let current = HostAuthority::new("host:input-host", replacement.generation).unwrap();
    for invalid_host in [host, &current] {
        assert!(matches!(
            store.take_input(invalid_host, &take(&attempt)).await,
            Err(StoreError::PermissionDenied)
        ));
        assert!(matches!(
            store
                .settle_input(
                    invalid_host,
                    &settle(&attempt, &input, LiveInputReceipt::Withdrawn)
                )
                .await,
            Err(StoreError::PermissionDenied)
        ));
    }
    store
        .resolve_attempt(
            OPERATOR,
            &ResolveAttemptRequest {
                task_id: target.task_id,
                attempt_id: attempt.attempt_id,
                operation_id: "recover-fenced-attempt".into(),
                decision: AttemptDecision::Failed.into(),
                evidence: "Verified replaced process stopped".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    clock.store(NOW + 20_000, Ordering::SeqCst);
    let failed = store
        .resolve_input(
            OPERATOR,
            &ResolveInputRequest {
                input_id: input.input_id,
                operation_id: "close-fenced-input".into(),
                decision: LiveInputDecision::Fail.into(),
                evidence: "Delivery cannot be confirmed".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(failed.state(), LiveInputState::Failed);
    assert_eq!(
        store
            .get_task(&input.follower_task_id)
            .await
            .unwrap()
            .state(),
        TaskState::Failed
    );
    store.close().await;
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    for tag in ["reviewer", "other-tag"] {
        store.put_tag(tag, "Review requests", vec![]).await.unwrap();
    }
    let host = support::register_host(&store, "input-host").await;
    let other = support::register_host(&store, "another-input-host").await;
    ordered_receipts(&store, &host, &other).await;
    uncertain_delivery(url, store, &clock, &host).await;
}

#[tokio::test]
async fn sqlite_live_input_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("input.db").display()
    );
    contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_live_input_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_input_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL live input contract failed");
}
