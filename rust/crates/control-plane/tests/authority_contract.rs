use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::{
    AppendEventRequest, Assignment, AttemptDecision, FinishTaskRequest, InspectAttemptRequest,
    ObjectiveSignal, ResolveAttemptRequest, StartTaskRequest, SubmitTaskRequest, TaskState,
};
use uuid::Uuid;

const BASE: i64 = 1_790_000_000_000;
const LEASE: i64 = 30_000;

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

async fn version_two_inflight_upgrade(url: &str, sqlite: bool) {
    sqlx::any::install_default_drivers();
    let mut database = sqlx::AnyConnection::connect(url).await.unwrap();
    let migrations = if sqlite {
        [
            include_str!("../migrations/sqlite/0001_initial.sql"),
            include_str!("../migrations/sqlite/0002_connector_outbox.sql"),
        ]
    } else {
        [
            include_str!("../migrations/postgresql/0001_initial.sql"),
            include_str!("../migrations/postgresql/0002_connector_outbox.sql"),
        ]
    };
    for migration in migrations {
        sqlx::raw_sql(migration)
            .execute(&mut database)
            .await
            .unwrap();
    }
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags VALUES ('upgrade', 'Original instructions', '[]', 1);
         INSERT INTO supertag_v2_tasks (task_id, tag_id, session_id, prompt, instructions, allowed_actions,
           tag_revision, state, attempt_id, host_principal, lease_token, accepted_order, cleanup_pending)
         VALUES ('upgrade-claimed','upgrade','claimed','Pending','Original instructions','[]',1,6,
           'claimed-attempt','host:upgrade','claimed-token',1,0),
           ('upgrade-running','upgrade','running','Started','Original instructions','[]',1,2,
           'running-attempt','host:upgrade','running-token',2,1);
         INSERT INTO supertag_v2_claims VALUES
           ('host:upgrade','claimed-operation','upgrade-claimed','claimed-attempt','claimed-token'),
           ('host:upgrade','running-operation','upgrade-running','running-attempt','running-token');
         UPDATE supertag_v2_write_order SET revision=2 WHERE singleton=1;",
    ).execute(&mut database).await.unwrap();
    database.close().await.unwrap();

    let store = Store::open(url).await.unwrap();
    let claimed = store.get_task("upgrade-claimed").await.unwrap();
    assert_eq!(claimed.state(), TaskState::Queued);
    assert_eq!(claimed.instructions, "Original instructions");
    assert!(claimed.attempt_id.is_none());
    assert!(
        store
            .claim_task("host:upgrade", "claimed-operation")
            .await
            .unwrap()
            .is_none()
    );
    store.cancel_task(&claimed.task_id).await.unwrap();
    let running = store.get_task("upgrade-running").await.unwrap();
    assert_eq!(running.state(), TaskState::Uncertain);
    assert_eq!(running.attempt_id.as_deref(), Some("running-attempt"));
    store
        .resolve_attempt(
            "operator:upgrade",
            &ResolveAttemptRequest {
                task_id: running.task_id,
                attempt_id: "running-attempt".into(),
                operation_id: "confirm-upgrade-cleanup".into(),
                decision: AttemptDecision::Failed.into(),
                evidence: "Verified original process exited.".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    store.close().await;
}

fn turn(operation_id: &str, session_id: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        tag_id: "reviewer".into(),
        session_id: session_id.into(),
        operation_id: operation_id.into(),
        prompt: "Review the patch".into(),
    }
}

fn inspect(assignment: &Assignment) -> InspectAttemptRequest {
    InspectAttemptRequest {
        task_id: assignment.task.as_ref().unwrap().task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
    }
}

fn start(identity: &InspectAttemptRequest) -> StartTaskRequest {
    StartTaskRequest {
        task_id: identity.task_id.clone(),
        attempt_id: identity.attempt_id.clone(),
        lease_token: identity.lease_token.clone(),
    }
}

fn event(identity: &InspectAttemptRequest, text: &str) -> AppendEventRequest {
    AppendEventRequest {
        task_id: identity.task_id.clone(),
        attempt_id: identity.attempt_id.clone(),
        lease_token: identity.lease_token.clone(),
        sequence: 1,
        text: text.into(),
    }
}

fn finish(identity: &InspectAttemptRequest) -> FinishTaskRequest {
    FinishTaskRequest {
        task_id: identity.task_id.clone(),
        attempt_id: identity.attempt_id.clone(),
        lease_token: identity.lease_token.clone(),
        result: "Native turn completed".into(),
        succeeded: true,
        objective_signal: ObjectiveSignal::Progress.into(),
    }
}

async fn authority_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let store = open(url, &clock).await;
    store
        .put_tag("reviewer", "Check the patch", vec![])
        .await
        .unwrap();

    let task = store
        .submit_task("operator:alice", &turn("first", "review"))
        .await
        .unwrap();
    let old_claim = store
        .claim_task("host:old", "lost-claim")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        store.claim_task("host:old", "lost-claim").await.unwrap(),
        Some(old_claim.clone())
    );
    clock.store(BASE + LEASE - 1, Ordering::SeqCst);
    assert!(
        store
            .claim_task("host:new", "new-claim")
            .await
            .unwrap()
            .is_none()
    );

    clock.store(BASE + LEASE, Ordering::SeqCst);
    let old = inspect(&old_claim);
    assert!(matches!(
        store.start_task("host:old", &start(&old)).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(store.sweep_expired_attempts().await.unwrap(), 1);
    assert_eq!(
        store.get_task(&task.task_id).await.unwrap().state(),
        TaskState::Queued
    );
    assert!(
        store
            .claim_task("host:old", "lost-claim")
            .await
            .unwrap()
            .is_none()
    );
    let new_claim = store
        .claim_task("host:new", "new-claim")
        .await
        .unwrap()
        .unwrap();
    let current = inspect(&new_claim);
    assert_eq!(current.task_id, old.task_id);
    assert_ne!(current.attempt_id, old.attempt_id);
    assert_ne!(current.lease_token, old.lease_token);
    assert!(matches!(
        store.start_task("host:old", &start(&old)).await,
        Err(StoreError::PermissionDenied)
    ));

    store
        .start_task("host:new", &start(&current))
        .await
        .unwrap();
    let first = store
        .append_event("host:new", &event(&current, "First attempt progress"))
        .await
        .unwrap();
    assert_eq!(first.sequence, 1);
    clock.store(BASE + 2 * LEASE - 1, Ordering::SeqCst);
    let authority = store.renew_attempt("host:new", &current).await.unwrap();
    assert_eq!(authority.task.unwrap().state(), TaskState::Running);
    assert_eq!(authority.valid_for_ms, LEASE as u64);
    assert!(matches!(
        store.renew_attempt("host:intruder", &current).await,
        Err(StoreError::PermissionDenied)
    ));

    let waiting = store
        .submit_task("operator:alice", &turn("second", "review"))
        .await
        .unwrap();
    clock.store(BASE + 3 * LEASE - 2, Ordering::SeqCst);
    store
        .start_task("host:new", &start(&current))
        .await
        .unwrap(); // Replay cannot extend a running lease.
    clock.store(BASE + 3 * LEASE - 1, Ordering::SeqCst);
    assert!(
        store
            .claim_task("host:other", "wait-for-cleanup")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.sweep_expired_attempts().await.unwrap(), 0);
    assert_eq!(
        store.get_task(&task.task_id).await.unwrap().state(),
        TaskState::Uncertain
    );
    assert_eq!(
        store
            .renew_attempt("host:new", &current)
            .await
            .unwrap()
            .valid_for_ms,
        0
    );
    assert_eq!(
        store
            .append_event("host:new", &event(&current, &first.text))
            .await
            .unwrap(),
        first
    );
    let expired_event = AppendEventRequest {
        sequence: 2,
        ..event(&current, "Expired event")
    };
    assert!(matches!(
        store.append_event("host:new", &expired_event).await,
        Err(StoreError::FailedPrecondition(_))
    ));

    let resolve = ResolveAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: current.attempt_id.clone(),
        operation_id: "operator-recovery".into(),
        decision: AttemptDecision::Retry.into(),
        evidence: "Host confirmed native execution stopped. Retry requested.".into(),
        confirmed_stopped: false,
    };
    assert!(matches!(
        store.resolve_attempt("operator:alice", &resolve).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // An old result can supply verified cleanup, but cannot replace uncertainty or release the Session.
    let late = store
        .finish_task("host:new", &finish(&current))
        .await
        .unwrap();
    assert_eq!(late.state(), TaskState::Uncertain);
    assert!(late.result.is_none());
    assert!(
        store
            .claim_task("host:other", "wait-for-cleanup")
            .await
            .unwrap()
            .is_none()
    );
    store.close().await;

    let store = open(url, &clock).await;
    assert!(
        store
            .get_attempt_resolution("host:new", &current)
            .await
            .unwrap()
            .is_none()
    );
    let (resolution, replay) = tokio::join!(
        store.resolve_attempt("operator:alice", &resolve),
        store.resolve_attempt("operator:alice", &resolve),
    );
    let resolution = resolution.unwrap();
    assert_eq!(resolution.operator_id, "alice");
    assert_eq!(resolution.evidence, resolve.evidence);
    assert_eq!(resolution.resolved_at_ms, BASE + 3 * LEASE - 1);
    assert_eq!(replay.unwrap(), resolution);
    let mut conflict = resolve.clone();
    conflict.evidence = "Different operation content".into();
    assert!(matches!(
        store.resolve_attempt("operator:alice", &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .get_attempt_resolution("host:intruder", &current)
            .await,
        Err(StoreError::PermissionDenied)
    ));

    let retried = store
        .claim_task("host:other", "wait-for-cleanup")
        .await
        .unwrap()
        .unwrap();
    let retried = inspect(&retried);
    assert_eq!(retried.task_id, task.task_id);
    assert_ne!(retried.attempt_id, current.attempt_id);
    assert_eq!(
        store
            .get_attempt_resolution("host:new", &current)
            .await
            .unwrap(),
        Some(resolution)
    );
    assert!(matches!(
        store.finish_task("host:new", &finish(&current)).await,
        Err(StoreError::PermissionDenied)
    ));

    store
        .start_task("host:other", &start(&retried))
        .await
        .unwrap();
    let repeated = event(&retried, "Replacement attempt progress");
    let accepted = store.append_event("host:other", &repeated).await.unwrap();
    assert_eq!(accepted.sequence, 1);
    assert_eq!(
        store.append_event("host:other", &repeated).await.unwrap(),
        accepted
    );
    let events = store.list_events(&task.task_id, 0, 10).await.unwrap();
    assert_eq!(
        events.iter().map(|item| item.sequence).collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(events[0].text, first.text);
    assert_eq!(events[1].text, repeated.text);

    // An explicit stopped observation can resolve an expired, cancelled Attempt.
    store.cancel_task(&task.task_id).await.unwrap();
    clock.store(BASE + 4 * LEASE, Ordering::SeqCst);
    assert!(
        store
            .claim_task("host:waiting", "waiting-claim")
            .await
            .unwrap()
            .is_none()
    );
    let cancel_resolve = ResolveAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: retried.attempt_id,
        operation_id: "stopped-cancelled-turn".into(),
        decision: AttemptDecision::Failed.into(),
        evidence: "Observed that the cancelled execution has no surviving processes.".into(),
        confirmed_stopped: true,
    };
    let retry_cancelled = ResolveAttemptRequest {
        decision: AttemptDecision::Retry.into(),
        ..cancel_resolve.clone()
    };
    assert!(matches!(
        store
            .resolve_attempt("operator:alice", &retry_cancelled)
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store
        .resolve_attempt("operator:alice", &cancel_resolve)
        .await
        .unwrap();
    assert_eq!(
        store.get_task(&task.task_id).await.unwrap().state(),
        TaskState::Cancelled
    );
    let next = store
        .claim_task("host:waiting", "waiting-claim")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.task.unwrap().task_id, waiting.task_id);
    store.close().await;
}

#[tokio::test]
async fn sqlite_execution_authority_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("authority.db").display()
    );
    version_two_inflight_upgrade(&url, true).await;
    authority_contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_execution_authority_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_authority_{}", Uuid::new_v4().simple());
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
            tokio::task::spawn_local(async move {
                version_two_inflight_upgrade(url.as_str(), false).await;
                authority_contract(url.as_str()).await;
            })
            .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL authority contract failed");
}
