//! A Tag's harness-native memory: the Control Plane grants each turn the store of its audience,
//! records what Worker Hosts report holding (never contents), shows each person only their own
//! private stores, and resets them on an operator's word.
mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const ALICE: &str = "operator:alice";
const BOB: &str = "operator:bob";
const TAG: &str = "keeper";

/// A turn of `principal`'s conversation with the Tag, claimed and running, with its grant.
async fn say(
    store: &Store,
    host: &HostAuthority,
    principal: &str,
) -> (InspectAttemptRequest, Option<NativeMemoryGrant>) {
    let task = store
        .send_message(
            principal,
            &SendMessageRequest {
                tag_id: TAG.into(),
                text: "Remember this".into(),
                operation_id: Uuid::new_v4().to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("expected Task");
    assert_eq!(assignment.task.as_ref().unwrap().task_id, task.task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
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
    (attempt, assignment.native_memory)
}

async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Done".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

fn report(
    attempt: &InspectAttemptRequest,
    revision: u64,
    generation: u64,
) -> ReportNativeMemoryRequest {
    ReportNativeMemoryRequest {
        attempt: Some(attempt.clone()),
        revision,
        files: 2,
        bytes: 120,
        digest: "a".repeat(64),
        reset_generation: generation,
    }
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    let host = support::register_host(&store, "memory-host").await;
    store
        .put_tag(TAG, "Keep memory", vec!["files:read".into()])
        .await
        .unwrap();

    // Each person's conversation gets its own private store; neither names the person.
    let (alice, alice_grant) = say(&store, &host, ALICE).await;
    let alice_grant = alice_grant.expect("a Tag that keeps memory grants native memory");
    assert!(
        alice_grant.scope.starts_with("person-"),
        "{}",
        alice_grant.scope
    );
    assert!(!alice_grant.scope.contains("alice"));
    assert_eq!(alice_grant.reset_generation, 0);
    store
        .report_native_memory(&host, &report(&alice, 1, 0))
        .await
        .unwrap();
    finish(&store, &host, &alice).await;
    let (bob, bob_grant) = say(&store, &host, BOB).await;
    assert_ne!(bob_grant.unwrap().scope, alice_grant.scope);
    store
        .report_native_memory(&host, &report(&bob, 3, 0))
        .await
        .unwrap();

    // Each person sees only their own private store.
    let seen = store.native_memory_stores(ALICE, TAG).await.unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].audience.as_deref(), Some(ALICE));
    assert_eq!(
        (seen[0].revision, seen[0].files, seen[0].bytes),
        (1, 2, 120)
    );
    assert_eq!(seen[0].host_id, "memory-host");
    assert_eq!(seen[0].harness, "custom");
    assert_eq!(seen[0].task_id, alice.task_id);
    assert_eq!(
        store.native_memory_stores(BOB, TAG).await.unwrap()[0].revision,
        3
    );

    // A report from a finished turn, or past the caps, is refused.
    assert!(matches!(
        store
            .report_native_memory(&host, &report(&alice, 2, 0))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let mut huge = report(&bob, 4, 0);
    huge.bytes = 4 * 1024 * 1024 + 1;
    assert!(store.report_native_memory(&host, &huge).await.is_err());

    // Only operators reset; a reset drops every record and starts a new generation.
    assert!(
        store
            .reset_native_memory(
                "client:carol",
                &ResetNativeMemoryRequest { tag_id: TAG.into() }
            )
            .await
            .is_err()
    );
    let reset = store
        .reset_native_memory(ALICE, &ResetNativeMemoryRequest { tag_id: TAG.into() })
        .await
        .unwrap();
    assert_eq!((reset.stores.len(), reset.reset_generation), (2, 1));
    assert!(
        store
            .native_memory_stores(BOB, TAG)
            .await
            .unwrap()
            .is_empty()
    );
    // Bob's turn began before the reset: its report changes nothing.
    store
        .report_native_memory(&host, &report(&bob, 4, 0))
        .await
        .unwrap();
    assert!(
        store
            .native_memory_stores(BOB, TAG)
            .await
            .unwrap()
            .is_empty()
    );
    finish(&store, &host, &bob).await;
    let (after, grant) = say(&store, &host, BOB).await;
    assert_eq!(grant.unwrap().reset_generation, 1);
    finish(&store, &host, &after).await;

    // memory: false turns native memory off with the notes.
    store
        .put_tag_spec(PutTagRequest {
            tag_id: TAG.into(),
            instructions: "No memory".into(),
            allowed_actions: vec!["files:read".into()],
            memory: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
    let (off, grant) = say(&store, &host, ALICE).await;
    assert!(grant.is_none());
    assert!(matches!(
        store.report_native_memory(&host, &report(&off, 1, 1)).await,
        Err(StoreError::PermissionDenied)
    ));
    store.close().await;
}

#[tokio::test]
async fn sqlite_native_memory_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("native.db").display()
    );
    contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_native_memory_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_native_memory_{}", Uuid::new_v4().simple());
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
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL native memory contract failed");
}
