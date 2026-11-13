use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const NOW: i64 = 1_790_000_000_000;

fn digest(secret: &str) -> Vec<u8> {
    Sha256::digest(secret).to_vec()
}

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
            "operator:alice",
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: operation.into(),
                prompt: "Check the patch".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap()
}

fn claim_identity(assignment: &Assignment) -> InspectAttemptRequest {
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

fn finish(identity: &InspectAttemptRequest) -> FinishTaskRequest {
    FinishTaskRequest {
        workspace_delivery: None,
        task_id: identity.task_id.clone(),
        attempt_id: identity.attempt_id.clone(),
        lease_token: identity.lease_token.clone(),
        result: "Done".into(),
        succeeded: true,
        ..Default::default()
    }
}

async fn host_enrollment_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    for tag in ["engineering", "out-of-scope"] {
        store.put_tag(tag, "Review requests", vec![]).await.unwrap();
    }
    let key = CreateAuthKeyRequest {
        name: "review".into(),
        host_id: "review-host".into(),
        operation_id: "issue-join".into(),
        key_digest: digest("one-time-review-key"),
        expires_in_ms: 1_000,
        allowed_tag_ids: vec!["engineering".into(), "engineering".into()],
        all_tags: false,
        ..Default::default()
    };
    let issued = store.create_auth_key("operator:alice", &key).await.unwrap();
    assert_eq!(issued.allowed_tag_ids, ["engineering"]);
    assert_eq!(issued.expires_at_ms, NOW + 1_000);
    assert_eq!(
        store.create_auth_key("operator:alice", &key).await.unwrap(),
        issued
    );
    let mut conflicting_key = key.clone();
    conflicting_key.expires_in_ms += 1;
    assert!(matches!(
        store
            .create_auth_key("operator:alice", &conflicting_key)
            .await,
        Err(StoreError::Conflict(_))
    ));

    let expired = CreateAuthKeyRequest {
        name: "expired".into(),
        host_id: "expired".into(),
        operation_id: "issue-expired".into(),
        key_digest: digest("expired-key"),
        expires_in_ms: 1,
        allowed_tag_ids: vec![],
        all_tags: true,
        ..Default::default()
    };
    store
        .create_auth_key("operator:alice", &expired)
        .await
        .unwrap();
    clock.store(NOW + 1, Ordering::SeqCst);
    let expired_join = EnrollHostRequest {
        host_id: expired.host_id,
        operation_id: "too-late".into(),
        token_digest: digest("expired-candidate"),
    };
    assert!(matches!(
        store.enroll_host(&expired_join, &expired.key_digest).await,
        Err(StoreError::PermissionDenied)
    ));

    let join = EnrollHostRequest {
        host_id: key.host_id.clone(),
        operation_id: "join-first".into(),
        token_digest: digest("first-private-candidate"),
    };
    let wrong_id = EnrollHostRequest {
        host_id: "other-host".into(),
        ..join.clone()
    };
    assert!(matches!(
        store.enroll_host(&wrong_id, &key.key_digest).await,
        Err(StoreError::PermissionDenied)
    ));
    let rival = EnrollHostRequest {
        operation_id: "join-rival".into(),
        token_digest: digest("second-private-candidate"),
        ..join.clone()
    };
    let (first, second) = tokio::join!(
        store.enroll_host(&join, &key.key_digest),
        store.enroll_host(&rival, &key.key_digest),
    );
    let (winner, loser, joined) = match (first, second) {
        (Ok(record), Err(StoreError::PermissionDenied)) => (&join, &rival, record),
        (Err(StoreError::PermissionDenied), Ok(record)) => (&rival, &join, record),
        outcome => panic!("one enrollment must succeed: {outcome:?}"),
    };
    assert_eq!(joined.host_id, key.host_id);
    assert_eq!(joined.generation, 0);
    assert_eq!(
        store.authenticate_host(&winner.token_digest).await.unwrap(),
        joined
    );
    assert!(matches!(
        store.authenticate_host(&loser.token_digest).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.authenticate_host(&key.key_digest).await,
        Err(StoreError::PermissionDenied)
    ));
    clock.store(issued.expires_at_ms, Ordering::SeqCst);
    assert_eq!(
        store.enroll_host(winner, &key.key_digest).await.unwrap(),
        joined
    );
    let modified_join = EnrollHostRequest {
        token_digest: loser.token_digest.clone(),
        ..winner.clone()
    };
    assert!(matches!(
        store.enroll_host(&modified_join, &key.key_digest).await,
        Err(StoreError::PermissionDenied)
    ));

    let principal = format!("host:{}", joined.host_id);
    let unregistered = HostAuthority::new(&principal, 1).unwrap();
    assert!(matches!(
        store.claim_task(&unregistered, "before-register").await,
        Err(StoreError::PermissionDenied)
    ));
    let first = store
        .register_host(&joined.host_id, "first-incarnation")
        .await
        .unwrap();
    assert_eq!(first.generation, 1);
    assert_eq!(
        store
            .register_host(&joined.host_id, "first-incarnation")
            .await
            .unwrap(),
        first
    );
    let original = HostAuthority::new(&principal, first.generation).unwrap();
    let forbidden = submit(&store, "out-of-scope", "another-team", "out-of-scope").await;
    let running = submit(&store, "engineering", "shared-session", "running").await;
    let following = submit(&store, "engineering", "shared-session", "following").await;
    let reserved = submit(&store, "engineering", "different-session", "reserved").await;
    let old = claim_identity(
        &store
            .claim_task(&original, "claim-running")
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(old.task_id, running.task_id);
    store.start_task(&original, &start(&old)).await.unwrap();
    let pending = claim_identity(
        &store
            .claim_task(&original, "claim-reserved")
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(pending.task_id, reserved.task_id);
    store.close().await;

    let store = open(url, &clock).await;
    assert_eq!(
        store
            .register_host(&joined.host_id, "first-incarnation")
            .await
            .unwrap(),
        first
    );
    let replacement = store
        .register_host(&joined.host_id, "replacement-incarnation")
        .await
        .unwrap();
    assert_eq!(replacement.generation, first.generation + 1);
    assert!(matches!(
        store
            .register_host(&joined.host_id, "first-incarnation")
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store.authenticate_host(&winner.token_digest).await.unwrap(),
        replacement
    );
    let current = HostAuthority::new(&principal, replacement.generation).unwrap();
    assert_eq!(
        store.get_task(&running.task_id).await.unwrap().state(),
        TaskState::Uncertain
    );
    assert_eq!(
        store.get_task(&reserved.task_id).await.unwrap().state(),
        TaskState::Queued
    );
    assert_eq!(
        store.get_task(&forbidden.task_id).await.unwrap().state(),
        TaskState::Queued
    );
    assert!(matches!(
        store.claim_task(&original, "stale-claim").await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.start_task(&original, &start(&pending)).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.renew_attempt(&original, &old).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.finish_task(&original, &finish(&old)).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.finish_task(&current, &finish(&old)).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .report_attempt_usage(
                &original,
                &ReportAttemptUsageRequest {
                    attempt: Some(old.clone()),
                    sequence: 1,
                    ..Default::default()
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(
        store
            .claim_task(&current, "claim-reserved")
            .await
            .unwrap()
            .is_none()
    );
    let reclaimed = claim_identity(
        &store
            .claim_task(&current, "reclaim-reserved")
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(reclaimed.task_id, reserved.task_id);
    assert_ne!(reclaimed.attempt_id, pending.attempt_id);
    assert!(
        store
            .claim_task(&current, "wait-on-session")
            .await
            .unwrap()
            .is_none()
    );

    let mut decision = ResolveAttemptRequest {
        task_id: old.task_id.clone(),
        attempt_id: old.attempt_id.clone(),
        operation_id: "recover-replaced-attempt".into(),
        decision: AttemptDecision::Failed.into(),
        evidence: "Verified original process exited".into(),
        confirmed_stopped: false,
    };
    assert!(matches!(
        store.resolve_attempt("operator:alice", &decision).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    decision.confirmed_stopped = true;
    let resolution = store
        .resolve_attempt("operator:alice", &decision)
        .await
        .unwrap();
    assert_eq!(
        store.get_attempt_resolution(&current, &old).await.unwrap(),
        Some(resolution)
    );
    assert!(matches!(
        store.get_attempt_resolution(&original, &old).await,
        Err(StoreError::PermissionDenied)
    ));
    let next = claim_identity(
        &store
            .claim_task(&current, "wait-on-session")
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(next.task_id, following.task_id);
    store.start_task(&current, &start(&next)).await.unwrap();

    let revoked = store.revoke_host(&joined.host_id).await.unwrap();
    assert!(revoked.revoked);
    assert_eq!(revoked.generation, replacement.generation + 1);
    assert_eq!(store.revoke_host(&joined.host_id).await.unwrap(), revoked);
    assert!(matches!(
        store.authenticate_host(&winner.token_digest).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .register_host(&joined.host_id, "third-incarnation")
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.finish_task(&current, &finish(&next)).await,
        Err(StoreError::PermissionDenied)
    ));
    assert_eq!(
        store.get_task(&next.task_id).await.unwrap().state(),
        TaskState::Uncertain
    );
    assert_eq!(
        store.get_task(&reclaimed.task_id).await.unwrap().state(),
        TaskState::Queued
    );

    let token = digest("private-local-bootstrap");
    assert_eq!(
        store.seed_host("local", &token).await.unwrap().generation,
        0
    );
    let local = store
        .register_host("local", "local-incarnation")
        .await
        .unwrap();
    assert_eq!(store.seed_host("local", &token).await.unwrap(), local);
    assert!(matches!(
        store.seed_host("local", &digest("changed")).await,
        Err(StoreError::Conflict(_))
    ));
    let revoked_local = store.revoke_host("local").await.unwrap();
    assert_eq!(
        store.seed_host("local", &token).await.unwrap(),
        revoked_local
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_host_enrollment_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("hosts.db").display()
    );
    host_enrollment_contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_host_enrollment_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_host_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { host_enrollment_contract(url.as_str()).await })
                .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL enrollment contract failed");
}
